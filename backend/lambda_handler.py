"""
backend/lambda_handlers.py

Collection of Lambda-compatible handlers for speech_to_insights.

Upgrades included:
- More robust API event parsing (JSON, base64 body, direct s3 refs).
- Optional presign PUT URL generation for uploads (if TRANSFORM_INPUT_BUCKET configured).
- Safer handling of multipart/base64 audio payloads.
- Option to start Step Functions execution after upload.
- Optional inline realtime transcription when whisper realtime is configured and payload is small.
- Uses local modules (whisper, transcribe, step_fn_handlers, pii_detector) when available.
- Clear, JSON-serializable return values and defensive error handling.

Deploy handlers as:
  backend.lambda_handlers.api_upload_handler
  backend.lambda_handlers.s3_event_handler
  backend.lambda_handlers.start_transform_handler
  backend.lambda_handlers.sagemaker_transform_callback
  backend.lambda_handlers.health_handler
"""

from __future__ import annotations

import os
import json
import base64
import logging
import uuid
import time
from typing import Dict, Any, Optional, Tuple

import boto3
from botocore.exceptions import ClientError

# Local modules (best-effort imports)
try:
    from . import whisper as whisper_module
except Exception:
    whisper_module = None

try:
    from . import transcribe as transcribe_module
except Exception:
    transcribe_module = None

try:
    from . import step_fn_handlers as sf_handlers
except Exception:
    sf_handlers = None

try:
    from . import pii_detector as pii_detector
except Exception:
    pii_detector = None

logger = logging.getLogger("lambda_handlers")
logger.setLevel(os.getenv("LOG_LEVEL", "INFO"))

# Configuration via env
TRANSFORM_INPUT_BUCKET = os.getenv("TRANSFORM_INPUT_BUCKET") or os.getenv("INPUT_S3_BUCKET")
TRANSFORM_INPUT_PREFIX = os.getenv("TRANSFORM_INPUT_PREFIX", "inputs")
TRANSFORM_OUTPUT_BUCKET = os.getenv("TRANSFORM_OUTPUT_BUCKET") or os.getenv("OUTPUT_S3_BUCKET")
STATE_MACHINE_ARN = os.getenv("STATE_MACHINE_ARN")
MAX_REALTIME_BYTES = int(os.getenv("MAX_REALTIME_BYTES", "5242880"))  # 5MB default
PRESIGN_URL_EXPIRES = int(os.getenv("PRESIGN_URL_EXPIRES", "900"))  # 15 minutes

# boto3 clients (module-level)
_s3 = boto3.client("s3")
_sfn = boto3.client("stepfunctions")
_sts = boto3.client("sts")


# -----------------------
# Helpers
# -----------------------
def _s3_key_for_upload(filename: str, prefix: Optional[str] = None, run_id: Optional[str] = None) -> str:
    run_id = run_id or uuid.uuid4().hex
    prefix = (prefix or TRANSFORM_INPUT_PREFIX).rstrip("/")
    safe_name = filename.replace(" ", "_")
    return f"{prefix}/{run_id}/{safe_name}"


def _upload_bytes_to_s3(data: bytes, bucket: str, key: str, content_type: Optional[str] = None) -> str:
    extra_args = {"ContentType": content_type} if content_type else {}
    try:
        _s3.put_object(Bucket=bucket, Key=key, Body=data, **(extra_args or {}))
    except ClientError as e:
        logger.exception("S3 put_object failed for s3://%s/%s", bucket, key)
        raise
    return f"s3://{bucket}/{key}"


def _generate_presigned_put(bucket: str, key: str, expires_in: int = PRESIGN_URL_EXPIRES, content_type: Optional[str] = None) -> Dict[str, str]:
    params = {"Bucket": bucket, "Key": key}
    if content_type:
        params["ContentType"] = content_type
    try:
        url = _s3.generate_presigned_url("put_object", Params=params, ExpiresIn=int(expires_in))
        return {"url": url, "s3_uri": f"s3://{bucket}/{key}"}
    except ClientError:
        logger.exception("Failed to generate presigned URL for s3://%s/%s", bucket, key)
        raise


def _parse_api_event_body(event: Dict[str, Any]) -> Dict[str, Any]:
    """
    Normalize API Gateway / ALB / Lambda proxy event body to a dict.
    Supports:
      - JSON bodies (application/json)
      - base64-encoded raw body (isBase64Encoded True)
      - pre-parsed structures where event already contains keys (s3_bucket, s3_key, audio_base64, filename)
    Returns a dict with keys possibly: s3_bucket, s3_key, audio_base64, audio_bytes (bytes), filename, start_workflow, presign, content_type
    """
    out: Dict[str, Any] = {}
    # Prefer explicit fields if present
    for k in ("s3_bucket", "s3_key", "audio_base64", "filename", "start_workflow", "presign", "content_type", "run_id"):
        if k in event:
            out[k] = event[k]

    # If there's a body, try to decode it
    body = event.get("body")
    if body is None:
        return out

    # If API Gateway base64-encoded payload
    if event.get("isBase64Encoded"):
        try:
            decoded = base64.b64decode(body)
            # If decoded looks like JSON, parse it
            try:
                parsed = json.loads(decoded.decode("utf-8"))
                out.update(parsed if isinstance(parsed, dict) else {"raw": parsed})
            except Exception:
                # treat as raw audio bytes
                out["audio_bytes"] = decoded
        except Exception:
            # fall back to treating body as raw text
            try:
                out.update(json.loads(body))
            except Exception:
                out["raw"] = body
        return out

    # Otherwise try to parse JSON text
    try:
        parsed = json.loads(body) if isinstance(body, str) else body
        if isinstance(parsed, dict):
            out.update(parsed)
    except Exception:
        # leave body as raw
        out["raw"] = body
    return out


def _maybe_start_workflow(s3_uri: str, run_id: str, metadata: Optional[Dict[str, Any]] = None) -> Optional[Dict[str, Any]]:
    if STATE_MACHINE_ARN and sf_handlers:
        try:
            payload = {"audio_s3_uri": s3_uri, "run_id": run_id, "metadata": metadata or {}}
            resp = sf_handlers.start_state_machine_execution(payload)
            return resp
        except Exception:
            logger.exception("Failed to start Step Functions execution for %s", s3_uri)
            return None
    return None


# -----------------------
# Lambda handlers
# -----------------------

def api_upload_handler(event: Dict[str, Any], context=None) -> Dict[str, Any]:
    """
    API Gateway-compatible Lambda to accept uploads or S3 references.

    Accepts:
      - direct s3 reference: {"s3_bucket": "...", "s3_key": "...", "start_workflow": true}
      - base64 audio payload: {"audio_base64": "...", "filename": "...", "content_type": "...", "start_workflow": true}
      - raw audio bytes when event['isBase64Encoded'] = True (body is base64)
      - presign request: {"presign": true, "filename": "...", "content_type": "audio/wav"}

    Returns:
      {"status": "uploaded"|"presigned"|"ok"|"error", "result": {...}}
    """
    logger.info("api_upload_handler invoked")
    try:
        parsed = _parse_api_event_body(event)

        # 1) If s3 ref provided, just acknowledge and optionally start workflow
        if parsed.get("s3_bucket") and parsed.get("s3_key"):
            s3_uri = f"s3://{parsed['s3_bucket'].rstrip('/')}/{parsed['s3_key'].lstrip('/')}"
            run_id = parsed.get("run_id") or uuid.uuid4().hex
            workflow = None
            if parsed.get("start_workflow"):
                workflow = _maybe_start_workflow(s3_uri, run_id, metadata=parsed.get("metadata"))
            return {"status": "ok", "result": {"upload_id": run_id, "s3_uri": s3_uri, "workflow": workflow}}

        # 2) If presign requested, create presigned PUT URL (requires TRANSFORM_INPUT_BUCKET)
        if parsed.get("presign"):
            filename = parsed.get("filename") or f"upload-{int(time.time())}.wav"
            if not TRANSFORM_INPUT_BUCKET:
                raise RuntimeError("TRANSFORM_INPUT_BUCKET not configured for presign")
            run_id = parsed.get("run_id") or uuid.uuid4().hex
            key = _s3_key_for_upload(filename, prefix=TRANSFORM_INPUT_PREFIX, run_id=run_id)
            presign = _generate_presigned_put(TRANSFORM_INPUT_BUCKET, key, expires_in=PRESIGN_URL_EXPIRES, content_type=parsed.get("content_type"))
            return {"status": "presigned", "result": {"upload_id": run_id, **presign}}

        # 3) If audio bytes/base64 provided, upload to S3
        audio_bytes = parsed.get("audio_bytes")
        if audio_bytes is None and parsed.get("audio_base64"):
            audio_bytes = base64.b64decode(parsed["audio_base64"])

        # If API Gateway sent base64 body, _parse_api_event_body may have put bytes under audio_bytes
        if audio_bytes is None and parsed.get("raw") and event.get("isBase64Encoded"):
            try:
                audio_bytes = base64.b64decode(parsed["raw"])
            except Exception:
                audio_bytes = None

        if audio_bytes is None:
            return {"status": "error", "error": "no_audio_or_s3_reference_provided"}

        if not TRANSFORM_INPUT_BUCKET:
            raise RuntimeError("TRANSFORM_INPUT_BUCKET not configured; cannot accept audio uploads")

        filename = parsed.get("filename") or f"upload-{int(time.time())}.wav"
        run_id = parsed.get("run_id") or uuid.uuid4().hex
        key = _s3_key_for_upload(filename, prefix=TRANSFORM_INPUT_PREFIX, run_id=run_id)
        content_type = parsed.get("content_type")
        s3_uri = _upload_bytes_to_s3(audio_bytes, TRANSFORM_INPUT_BUCKET, key, content_type=content_type)

        result: Dict[str, Any] = {"upload_id": run_id, "s3_uri": s3_uri, "s3_bucket": TRANSFORM_INPUT_BUCKET, "s3_key": key}

        # If small enough and whisper realtime is available, try inline realtime transcription
        try:
            if len(audio_bytes) <= MAX_REALTIME_BYTES and whisper_module and getattr(whisper_module, "transcribe_bytes_realtime", None):
                out = whisper_module.transcribe_bytes_realtime(audio_bytes)
                text = out.get("text", "")
                result["mode"] = "realtime"
                result["transcript"] = text
        except Exception:
            logger.exception("Inline realtime transcription failed; continuing")

        # Optionally start state machine execution
        if parsed.get("start_workflow"):
            wf = _maybe_start_workflow(s3_uri, run_id, metadata=parsed.get("metadata"))
            result["workflow"] = wf

        return {"status": "uploaded", "result": result}
    except Exception as exc:
        logger.exception("api_upload_handler failed")
        return {"status": "error", "error": str(exc)}


def s3_event_handler(event: Dict[str, Any], context=None) -> Dict[str, Any]:
    """
    Handle S3 ObjectCreated events. Delegates to whisper.process_s3_event_and_transcribe when available.
    Returns summary per record.
    """
    logger.info("s3_event_handler invoked")
    results = []
    records = (event.get("Records") or []) if isinstance(event, dict) else []
    if not records:
        return {"status": "noop", "reason": "no-records"}

    for rec in records:
        try:
            s3info = rec.get("s3", {})
            bucket = s3info.get("bucket", {}).get("name")
            key = s3info.get("object", {}).get("key")
            if not bucket or not key:
                results.append({"ok": False, "error": "invalid_record"})
                continue

            if whisper_module and getattr(whisper_module, "process_s3_event_and_transcribe", None):
                res = whisper_module.process_s3_event_and_transcribe(rec)
                results.append({"ok": True, "result": res})
            elif transcribe_module and getattr(transcribe_module, "transcribe_s3_uri", None):
                res = transcribe_module.transcribe_s3_uri(f"s3://{bucket}/{key}")
                results.append({"ok": True, "result": res})
            else:
                results.append({"ok": False, "error": "no_transcription_module"})
        except Exception as e:
            logger.exception("Error processing S3 record")
            results.append({"ok": False, "error": str(e)})

    return {"status": "processed", "results": results}


def start_transform_handler(event: Dict[str, Any], context=None) -> Dict[str, Any]:
    """
    Start a SageMaker Batch Transform job for given input.
    Event expects: {"s3_input": "s3://bucket/key", "output_s3_uri": "s3://bucket/prefix", "job_name": "..."}
    """
    logger.info("start_transform_handler invoked")
    if not whisper_module or not getattr(whisper_module, "start_sagemaker_transform", None):
        return {"status": "error", "error": "whisper.start_sagemaker_transform not available"}

    s3_input = event.get("s3_input")
    output_s3_uri = event.get("output_s3_uri") or TRANSFORM_OUTPUT_BUCKET
    job_name = event.get("job_name")

    if not s3_input or not output_s3_uri:
        return {"status": "error", "error": "s3_input and output_s3_uri required"}

    try:
        resp = whisper_module.start_sagemaker_transform(s3_input, output_s3_uri, job_name=job_name)
        return {"status": "started", "transform_job": resp}
    except Exception:
        logger.exception("Failed to start transform")
        return {"status": "error", "error": "start_transform_failed"}


def sagemaker_transform_callback(event: Dict[str, Any], context=None) -> Dict[str, Any]:
    """
    Callback handler when transform outputs are ready. Optionally sends Step Functions callback if taskToken provided.
    Event shape:
      {"run_id": "...", "s3_bucket": "...", "s3_prefix": "...", "taskToken": "..."}
    """
    logger.info("sagemaker_transform_callback invoked")
    task_token = event.get("taskToken")
    bucket = event.get("s3_bucket") or TRANSFORM_OUTPUT_BUCKET
    prefix = event.get("s3_prefix")
    run_id = event.get("run_id", uuid.uuid4().hex)

    if not bucket or not prefix:
        return {"status": "error", "error": "s3_bucket and s3_prefix required"}

    try:
        resp = _s3.list_objects_v2(Bucket=bucket, Prefix=prefix)
        keys = [c["Key"] for c in resp.get("Contents", [])] if resp.get("Contents") else []
        result = {"run_id": run_id, "s3_bucket": bucket, "s3_prefix": prefix, "keys": keys}

        # send task success if step fn token present
        if task_token and sf_handlers:
            try:
                # step_fn_handlers exposes _send_task_success internal helper; call it if present
                send_success = getattr(sf_handlers, "_send_task_success", None)
                if callable(send_success):
                    send_success(task_token, result)
            except Exception:
                logger.exception("Failed to send task success to Step Functions")

        return {"status": "ok", "result": result}
    except Exception as exc:
        logger.exception("sagemaker_transform_callback failed")
        if task_token and sf_handlers:
            try:
                send_failure = getattr(sf_handlers, "_send_task_failure", None)
                if callable(send_failure):
                    send_failure(task_token, error="TransformCallbackError", cause=str(exc))
            except Exception:
                logger.exception("Failed to send task failure to Step Functions")
        return {"status": "error", "error": str(exc)}


def health_handler(event: Dict[str, Any], context=None) -> Dict[str, Any]:
    """
    Lightweight health probe for Lambda.
    """
    out = {"status": "ok", "ts": int(time.time())}
    # check S3 input bucket availability
    try:
        if TRANSFORM_INPUT_BUCKET:
            _s3.list_objects_v2(Bucket=TRANSFORM_INPUT_BUCKET, MaxKeys=1)
            out["s3_input_bucket_ok"] = True
        else:
            out["s3_input_bucket_ok"] = False
    except Exception:
        out["s3_input_bucket_ok"] = False

    out["step_functions_configured"] = bool(STATE_MACHINE_ARN)
    out["whisper_available"] = whisper_module is not None
    out["transcribe_available"] = transcribe_module is not None
    return out
