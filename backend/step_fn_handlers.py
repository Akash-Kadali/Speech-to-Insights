"""
backend/step_fn_handlers.py

Helpers and Lambda handlers for orchestrating the speech_to_insights pipeline with AWS Step Functions.

Upgrades / new features included:
- Configurable polling/backoff for wait_for_transform_callback.
- Ability to wait on either S3 prefix presence OR a SageMaker transform job name/status.
- Optional SNS notifications on important lifecycle events (configured via NOTIFY_SNS_TOPIC_ARN).
- More robust S3 reading: supports JSON, JSONL, plain text, gzipped jsonl outputs.
- Better error reporting and structured logs.
- Safe serialization and small defensive guards.

Environment variables used:
- STATE_MACHINE_ARN
- OUTPUT_S3_BUCKET
- OUTPUT_S3_PREFIX
- LOG_LEVEL
- NOTIFY_SNS_TOPIC_ARN (optional)
"""

from __future__ import annotations

import os
import json
import logging
import time
import uuid
import gzip
from typing import Dict, Optional, Any, List
from io import BytesIO

# boto3 imported defensively; some test environments lack it
try:
    import boto3  # type: ignore
    from botocore.exceptions import ClientError, BotoCoreError  # type: ignore
    _BOTO3_AVAILABLE = True
except Exception:
    boto3 = None  # type: ignore
    ClientError = Exception
    BotoCoreError = Exception
    _BOTO3_AVAILABLE = False

LOG_LEVEL = os.getenv("LOG_LEVEL", "INFO").upper()
logger = logging.getLogger("stepfn")
logger.setLevel(getattr(logging, LOG_LEVEL, logging.INFO))

# boto3 clients (lazily created)
_sfn = None
_s3 = None
_sm = None
_sns = None

def sfn_client():
    global _sfn
    if _sfn is None:
        if not _BOTO3_AVAILABLE:
            raise RuntimeError("boto3 is not available in this environment")
        _sfn = boto3.client("stepfunctions")
    return _sfn

def s3_client():
    global _s3
    if _s3 is None:
        if not _BOTO3_AVAILABLE:
            raise RuntimeError("boto3 is not available in this environment")
        _s3 = boto3.client("s3")
    return _s3

def sagemaker_client():
    global _sm
    if _sm is None:
        if not _BOTO3_AVAILABLE:
            raise RuntimeError("boto3 is not available in this environment")
        _sm = boto3.client("sagemaker")
    return _sm

def sns_client():
    global _sns
    if _sns is None:
        if not _BOTO3_AVAILABLE:
            raise RuntimeError("boto3 is not available in this environment")
        _sns = boto3.client("sns")
    return _sns

# Config
STATE_MACHINE_ARN = os.getenv("STATE_MACHINE_ARN")
OUTPUT_S3_BUCKET = os.getenv("OUTPUT_S3_BUCKET")
OUTPUT_S3_PREFIX = os.getenv("OUTPUT_S3_PREFIX", "outputs")
NOTIFY_SNS_TOPIC_ARN = os.getenv("NOTIFY_SNS_TOPIC_ARN")  # optional SNS topic for notifications

# ---------------------------------------------------------------------------
# Utilities: Step Functions callback helpers
# ---------------------------------------------------------------------------

def _safe_serialize(obj: Any) -> str:
    try:
        return json.dumps(obj, default=str)
    except Exception:
        try:
            return str(obj)
        except Exception:
            return "{}"

def _send_task_success(task_token: Optional[str], output: Any) -> None:
    if not task_token:
        logger.debug("No task token provided; skipping send_task_success")
        return
    try:
        sfn = sfn_client()
        payload = _safe_serialize(output)
        sfn.send_task_success(taskToken=task_token, output=payload)
        logger.info("Sent task success for token")
    except Exception as e:
        logger.exception("Failed to send task success: %s", e)
        raise

def _send_task_failure(task_token: Optional[str], error: str, cause: Optional[str] = None) -> None:
    if not task_token:
        logger.debug("No task token provided; skipping send_task_failure")
        return
    try:
        sfn = sfn_client()
        sfn.send_task_failure(taskToken=task_token, error=error, cause=str(cause or ""))
        logger.info("Sent task failure for token: %s", error)
    except Exception as e:
        logger.exception("Failed to send task failure: %s", e)
        raise

def _notify_via_sns(subject: str, message: Any) -> None:
    if not NOTIFY_SNS_TOPIC_ARN:
        logger.debug("No SNS topic configured; skipping notify")
        return
    if not _BOTO3_AVAILABLE:
        logger.debug("boto3 not available; cannot publish SNS message")
        return
    try:
        sns = sns_client()
        sns.publish(TopicArn=NOTIFY_SNS_TOPIC_ARN, Subject=subject[:100], Message=_safe_serialize(message))
        logger.info("Published notification to SNS %s", NOTIFY_SNS_TOPIC_ARN)
    except Exception:
        logger.exception("Failed to publish SNS notification; continuing")

# ---------------------------------------------------------------------------
# Utilities: S3 helpers for storing manifests / results (improved)
# ---------------------------------------------------------------------------

def _s3_put_json(bucket: str, key: str, obj: Any) -> str:
    if not _BOTO3_AVAILABLE:
        raise RuntimeError("boto3 is not available in this environment")
    s3 = s3_client()
    body = json.dumps(obj, default=str).encode("utf-8")
    logger.debug("Uploading JSON to s3://%s/%s (bytes=%d)", bucket, key, len(body))
    try:
        s3.put_object(Bucket=bucket, Key=key, Body=body, ContentType="application/json")
    except ClientError as e:
        logger.exception("Failed to upload JSON to S3: %s", e)
        raise
    return f"s3://{bucket}/{key}"

def _write_result_to_s3(result_obj: Dict, run_id: Optional[str] = None) -> str:
    if not OUTPUT_S3_BUCKET:
        raise RuntimeError("OUTPUT_S3_BUCKET is not configured")
    run_id = run_id or uuid.uuid4().hex
    key = f"{OUTPUT_S3_PREFIX.rstrip('/')}/{run_id}/result.json"
    return _s3_put_json(OUTPUT_S3_BUCKET, key, result_obj)

def _read_s3_object_bytes(bucket: str, key: str) -> bytes:
    if not _BOTO3_AVAILABLE:
        raise RuntimeError("boto3 is not available in this environment")
    s3 = s3_client()
    try:
        resp = s3.get_object(Bucket=bucket, Key=key)
        return resp["Body"].read()
    except ClientError as e:
        logger.exception("Failed to read s3://%s/%s: %s", bucket, key, e)
        raise

def _parse_possible_json_or_text(raw: bytes) -> Any:
    """
    Try to parse JSON, then JSONL (first line), then gzipped JSON/JSONL, then fallback to text.
    """
    if not raw:
        return None
    # try plain json
    try:
        return json.loads(raw.decode("utf-8"))
    except Exception:
        pass
    # try jsonl: take non-empty first line
    try:
        text = raw.decode("utf-8", errors="replace").strip()
        if "\n" in text:
            first = text.splitlines()[0].strip()
            return json.loads(first)
    except Exception:
        pass
    # try gzipped
    try:
        with gzip.GzipFile(fileobj=BytesIO(raw)) as gz:
            content = gz.read()
            try:
                return json.loads(content.decode("utf-8"))
            except Exception:
                txt = content.decode("utf-8", errors="replace").strip()
                if "\n" in txt:
                    first = txt.splitlines()[0].strip()
                    return json.loads(first)
    except Exception:
        pass
    # fallback to text
    try:
        return raw.decode("utf-8", errors="replace")
    except Exception:
        return str(raw)

# ---------------------------------------------------------------------------
# Helper: start state machine execution (callable from HTTP endpoint)
# ---------------------------------------------------------------------------

def start_state_machine_execution(input_obj: Dict, name: Optional[str] = None, tags: Optional[List[Dict[str,str]]] = None) -> Dict:
    """
    Start a Step Functions execution and return metadata.
    """
    if not STATE_MACHINE_ARN:
        raise RuntimeError("STATE_MACHINE_ARN not configured")
    try:
        sfn = sfn_client()
    except Exception:
        raise RuntimeError("Failed to create Step Functions client")

    name = name or f"speech-run-{int(time.time())}-{uuid.uuid4().hex[:6]}"
    logger.info("Starting state machine %s with name %s", STATE_MACHINE_ARN, name)
    try:
        kwargs = {"stateMachineArn": STATE_MACHINE_ARN, "name": name, "input": json.dumps(input_obj)}
        if tags:
            kwargs["tags"] = tags
        resp = sfn.start_execution(**kwargs)
        logger.debug("start_execution resp: %s", resp)
        start_date = resp.get("startDate")
        start_date_iso = start_date.isoformat() if hasattr(start_date, "isoformat") else str(start_date)
        return {"executionArn": resp.get("executionArn"), "startDate": start_date_iso}
    except ClientError as e:
        logger.exception("Failed to start state machine execution: %s", e)
        raise

# ---------------------------------------------------------------------------
# Lambda Task Handlers
# ---------------------------------------------------------------------------

def start_transcription(event: Dict, context=None) -> Dict:
    """
    Validate/normalize input and return an S3 input location for downstream tasks.
    """
    logger.info("start_transcription invoked with keys: %s", list(event.keys()) if isinstance(event, dict) else str(type(event)))
    task_token = event.get("taskToken")
    try:
        # Resolve s3 uri
        if "audio_s3_uri" in event:
            s3_input = event["audio_s3_uri"]
        elif "s3_bucket" in event and "s3_key" in event:
            s3_input = f"s3://{event['s3_bucket'].rstrip('/')}/{event['s3_key'].lstrip('/')}"
        else:
            raise ValueError("Missing audio_s3_uri or s3_bucket + s3_key")

        run_id = event.get("run_id") or uuid.uuid4().hex
        metadata = event.get("metadata", {})

        output_obj = {
            "s3_input": s3_input,
            "run_id": run_id,
            "metadata": metadata
        }

        # Optionally persist a manifest for traceability
        try:
            if OUTPUT_S3_BUCKET:
                manifest_key = f"{OUTPUT_S3_PREFIX.rstrip('/')}/{run_id}/manifest.json"
                manifest_uri = _s3_put_json(OUTPUT_S3_BUCKET, manifest_key, output_obj)
                output_obj["manifest_s3_uri"] = manifest_uri
        except Exception:
            logger.exception("Failed to persist manifest to S3; continuing")

        # If callback pattern: send success back immediately with payload
        try:
            _send_task_success(task_token, output_obj)
        except Exception:
            logger.exception("send_task_success failed; continuing")

        # Also optionally notify via SNS
        _notify_via_sns("start_transcription", {"run_id": run_id, "s3_input": s3_input})
        return output_obj
    except Exception as e:
        logger.exception("start_transcription failed: %s", e)
        try:
            _send_task_failure(task_token, error="StartTranscriptionError", cause=str(e))
        except Exception:
            logger.exception("Failed to send task failure")
        raise

def wait_for_transform_callback(event: Dict, context=None) -> Dict:
    """
    Wait for transform outputs. New features:
    - Accepts either expected_s3_prefix OR expected_sagemaker_transform_job_name.
    - Configurable poll_interval_seconds, timeout_seconds, max_retries, backoff_factor.
    - Supports callback pattern via taskToken.
    """
    logger.info("wait_for_transform_callback invoked")
    task_token = event.get("taskToken")
    run_id = event.get("run_id")
    expected_s3_prefix = event.get("expected_s3_prefix")
    expected_transform_job_name = event.get("expected_sagemaker_transform_job_name")
    poll_interval = int(event.get("poll_interval_seconds", 10))
    timeout = int(event.get("timeout_seconds", 60 * 60))
    backoff = float(event.get("backoff_factor", 1.5))
    max_retries = int(event.get("max_retries", 0))

    if not task_token:
        raise ValueError("taskToken is required for callback-based wait handler")
    if not expected_s3_prefix and not expected_transform_job_name:
        raise ValueError("Either expected_s3_prefix or expected_sagemaker_transform_job_name is required")

    # Clients (may raise if boto3 not available)
    try:
        s3 = s3_client()
    except Exception:
        s3 = None
    try:
        sm = sagemaker_client()
    except Exception:
        sm = None

    start_time = time.time()
    attempt = 0
    discovered_objects: List[str] = []

    try:
        while True:
            elapsed = time.time() - start_time
            if elapsed > timeout:
                msg = f"Timeout waiting for transform outputs (run_id={run_id})"
                logger.error(msg)
                _send_task_failure(task_token, error="TransformTimeout", cause=msg)
                _notify_via_sns("transform_timeout", {"run_id": run_id, "reason": msg})
                return {"ok": False, "reason": "timeout"}

            # If waiting on SageMaker transform job status
            if expected_transform_job_name and sm is not None:
                try:
                    resp = sm.describe_transform_job(TransformJobName=expected_transform_job_name)
                    status = resp.get("TransformJobStatus")
                    logger.info("Transform job %s status=%s", expected_transform_job_name, status)
                    if status == "Completed":
                        s3_output = resp.get("TransformOutput", {}).get("S3OutputPath")
                        result_obj = {"transform_job": expected_transform_job_name, "status": status, "s3_output": s3_output}
                        _send_task_success(task_token, result_obj)
                        _notify_via_sns("transform_completed", result_obj)
                        return {"ok": True, "result": result_obj}
                    if status in ("Failed", "Stopped"):
                        msg = f"Transform job {expected_transform_job_name} ended with status {status}"
                        _send_task_failure(task_token, error="TransformJobFailed", cause=msg)
                        _notify_via_sns("transform_failed", {"transform_job": expected_transform_job_name, "status": status})
                        return {"ok": False, "reason": status}
                except ClientError:
                    logger.exception("Failed to describe transform job %s", expected_transform_job_name)

            # If waiting on S3 prefix presence
            if expected_s3_prefix:
                if expected_s3_prefix.startswith("s3://"):
                    # parse s3://bucket/prefix
                    tail = expected_s3_prefix[5:]
                    parts = tail.split("/", 1)
                    bucket = parts[0]
                    prefix = parts[1] if len(parts) > 1 else ""
                else:
                    if not OUTPUT_S3_BUCKET:
                        raise ValueError("expected_s3_prefix not an s3 uri and OUTPUT_S3_BUCKET not configured")
                    bucket = OUTPUT_S3_BUCKET
                    prefix = expected_s3_prefix.lstrip("/")

                try:
                    resp = s3.list_objects_v2(Bucket=bucket, Prefix=prefix, MaxKeys=1000)
                except Exception:
                    logger.exception("S3 list_objects_v2 failed for s3://%s/%s", bucket, prefix)
                    resp = {}

                contents = resp.get("Contents", []) if isinstance(resp, dict) else []
                if contents:
                    discovered_objects = [c["Key"] for c in contents]
                    logger.info("Found %d objects under prefix s3://%s/%s", len(contents), bucket, prefix)
                    result_obj = {"s3_keys": discovered_objects, "bucket": bucket, "prefix": prefix}
                    _send_task_success(task_token, result_obj)
                    _notify_via_sns("s3_outputs_found", result_obj)
                    return {"ok": True, "result": result_obj}

            # Backoff/poll control
            attempt += 1
            if max_retries and attempt > max_retries:
                msg = f"Max retries exceeded while waiting for outputs (attempts={attempt})"
                logger.error(msg)
                _send_task_failure(task_token, error="MaxRetriesExceeded", cause=msg)
                _notify_via_sns("transform_max_retries_exceeded", {"run_id": run_id})
                return {"ok": False, "reason": "max_retries_exceeded"}
            sleep_t = poll_interval * (backoff ** max(0, attempt - 1))
            logger.debug("No outputs yet; sleeping %ds (attempt %d)", sleep_t, attempt)
            time.sleep(sleep_t)

    except Exception as e:
        logger.exception("Error while waiting for transform: %s", e)
        try:
            _send_task_failure(task_token, error="TransformWaitError", cause=str(e))
        except Exception:
            logger.exception("Failed to send task failure")
        _notify_via_sns("transform_wait_error", {"run_id": run_id, "error": str(e)})
        raise

def aggregate_results(event: Dict, context=None) -> Dict:
    """
    Aggregate transform outputs into a final payload.

    New features:
    - Read multiple output file formats: JSON, JSONL, gzipped JSON/JSONL, or plain text.
    - Optional PII detection via backend.pii_detector.detect_pii (if available).
    - Optionally write a consolidated result to OUTPUT_S3_BUCKET and return its URI.
    """
    logger.info("aggregate_results invoked")
    task_token = event.get("taskToken")
    run_id = event.get("run_id")
    s3_bucket = event.get("s3_bucket") or OUTPUT_S3_BUCKET
    s3_keys = event.get("s3_keys") or []

    if not run_id:
        raise ValueError("run_id is required")
    if not s3_bucket:
        raise ValueError("s3_bucket is required (or configure OUTPUT_S3_BUCKET)")
    if not s3_keys:
        logger.warning("No s3_keys provided; nothing to aggregate")
        return {"run_id": run_id, "num_parts": 0, "transcripts": [], "concatenated_transcript": ""}

    transcripts = []
    metadata = {"sources": []}

    try:
        for key in s3_keys:
            try:
                raw = _read_s3_object_bytes(s3_bucket, key)
                parsed = _parse_possible_json_or_text(raw)
                # prefer explicit fields if present
                if isinstance(parsed, dict) and ("transcript" in parsed or "text" in parsed):
                    t = parsed.get("transcript") or parsed.get("text")
                    transcripts.append({"key": key, "transcript": t, "meta": parsed})
                else:
                    transcripts.append({"key": key, "transcript": parsed, "meta": {}})
                metadata["sources"].append(key)
            except Exception:
                logger.exception("Failed to read/parse S3 object %s/%s; skipping", s3_bucket, key)

        # Concatenate transcripts conservatively
        concatenated = "\n".join(
            (t["transcript"] if isinstance(t["transcript"], str) else json.dumps(t["transcript"]))
            for t in transcripts if t.get("transcript") is not None
        )

        result_obj: Dict[str, Any] = {
            "run_id": run_id,
            "num_parts": len(transcripts),
            "transcripts": transcripts,
            "concatenated_transcript": concatenated,
            "metadata": metadata,
            "timestamp": int(time.time())
        }

        # Optional PII detection
        try:
            from .pii_detector import detect_pii  # type: ignore
            pii_report = detect_pii(concatenated)
            result_obj["pii_report"] = pii_report
        except Exception:
            logger.debug("No pii_detector available or it failed; continuing without PII report", exc_info=True)

        # Persist final result for traceability
        try:
            if OUTPUT_S3_BUCKET:
                uri = _write_result_to_s3(result_obj, run_id=run_id)
                result_obj["result_s3_uri"] = uri
        except Exception:
            logger.exception("Failed to persist final result; continuing")

        try:
            _send_task_success(task_token, result_obj)
        except Exception:
            logger.exception("Failed to send task success for aggregate_results")

        _notify_via_sns("aggregate_results_complete", {"run_id": run_id, "num_parts": len(transcripts)})
        return result_obj

    except Exception as e:
        logger.exception("aggregate_results failed: %s", e)
        try:
            _send_task_failure(task_token, error="AggregateResultsError", cause=str(e))
        except Exception:
            logger.exception("Failed to send task failure for aggregate_results")
        _notify_via_sns("aggregate_results_failed", {"run_id": run_id, "error": str(e)})
        raise

def notify(event: Dict, context=None) -> Dict:
    """
    Lightweight notification handler that writes status JSON to S3 (if configured) and optionally publishes SNS.
    """
    logger.info("notify invoked")
    task_token = event.get("taskToken")
    run_id = event.get("run_id", uuid.uuid4().hex)
    status = event.get("status", "unknown")
    message = event.get("message", "")

    obj = {
        "run_id": run_id,
        "status": status,
        "message": message,
        "ts": int(time.time())
    }

    try:
        if OUTPUT_S3_BUCKET:
            key = f"{OUTPUT_S3_PREFIX.rstrip('/')}/{run_id}/status.json"
            uri = _s3_put_json(OUTPUT_S3_BUCKET, key, obj)
            obj["s3_uri"] = uri
    except Exception:
        logger.exception("Failed to write notification to S3; continuing")

    try:
        _send_task_success(task_token, obj)
    except Exception:
        logger.exception("Failed to send task success in notify")

    try:
        _notify_via_sns("pipeline_notification", obj)
    except Exception:
        logger.debug("SNS notify failed; continuing")
    return obj

# ---------------------------------------------------------------------------
# Generic Lambda entrypoint
# ---------------------------------------------------------------------------

def lambda_handler(event: Dict, context=None) -> Dict:
    """
    Generic Lambda entry that routes by `action` in the event.
    Valid actions:
      - start_transcription
      - wait_for_transform_callback
      - aggregate_results
      - notify
    """
    logger.info("lambda_handler invoked with keys: %s", list(event.keys()) if isinstance(event, dict) else str(type(event)))
    action = event.get("action")
    if not action:
        raise ValueError("Missing 'action' in event")

    if action == "start_transcription":
        return start_transcription(event, context)
    if action == "wait_for_transform_callback":
        return wait_for_transform_callback(event, context)
    if action == "aggregate_results":
        return aggregate_results(event, context)
    if action == "notify":
        return notify(event, context)

    raise ValueError(f"Unknown action: {action}")
