# backend/whisper.py
"""
Upgraded whisper.py

Responsibilities
- Support two Whisper modes:
    1) Real-time / small-file: invoke a SageMaker realtime endpoint.
    2) Batch / large-file: start a SageMaker Batch Transform job (transform).
- Handle S3 event payloads (Lambda entrypoint).
- Optional lightweight PII redaction (placeholder).
- Clear logging and robust error handling.

Environment variables (recommended):
- AWS_REGION                 (optional, boto3 default will apply)
- SAGEMAKER_ENDPOINT         -> realtime endpoint name (string)
- SAGEMAKER_TRANSFORM_ROLE   -> IAM role ARN for transform jobs
- SAGEMAKER_MODEL_NAME       -> model name for transform job naming/metadata
- SAGEMAKER_TRANSFORM_INSTANCE_TYPE -> e.g. "ml.g4dn.xlarge"
- TRANSFORM_OUTPUT_BUCKET    -> S3 bucket for transform outputs (uri: s3://bucket/prefix or bucket/prefix)
- MAX_REALTIME_BYTES         -> threshold in bytes below which we use realtime endpoint (default 5MB)
- TRANSFORM_POLL_INTERVAL    -> initial poll interval seconds for transform waits (default 10)
- TRANSFORM_POLL_MAX_BACKOFF -> max backoff seconds for transform waits (default 60)
"""

from __future__ import annotations

import os
import json
import base64
import logging
import re
import time
import uuid
import math
import mimetypes
from typing import Optional, Dict, Tuple, Any, List, Callable
from functools import wraps

# boto3 import defensively for test environments that might not have AWS SDK
try:
    import boto3  # type: ignore
    from botocore.exceptions import ClientError  # type: ignore
    _BOTO3_AVAILABLE = True
except Exception:
    boto3 = None  # type: ignore
    ClientError = Exception
    _BOTO3_AVAILABLE = False

logger = logging.getLogger("whisper")
logger.setLevel(os.getenv("LOG_LEVEL", "INFO").upper())
if not logger.handlers:
    ch = logging.StreamHandler()
    ch.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
    logger.addHandler(ch)

# --- Lazy boto clients (module-level cached) --------------------------------
_sagemaker_runtime = None
_sagemaker = None
_s3 = None


def boto_client(name: str, **kwargs):
    """Return cached boto3 client for given service name."""
    global _sagemaker_runtime, _sagemaker, _s3
    if not _BOTO3_AVAILABLE:
        raise RuntimeError("boto3 is not available in this environment")
    # allow passing region_name via env or kwargs
    region = os.getenv("AWS_REGION") or os.getenv("AWS_DEFAULT_REGION")
    client_kwargs = dict(region_name=region) if region and "region_name" not in kwargs else {}
    client_kwargs.update(kwargs or {})
    if name == "sagemaker-runtime":
        if _sagemaker_runtime is None:
            _sagemaker_runtime = boto3.client("sagemaker-runtime", **client_kwargs)
        return _sagemaker_runtime
    if name == "sagemaker":
        if _sagemaker is None:
            _sagemaker = boto3.client("sagemaker", **client_kwargs)
        return _sagemaker
    if name == "s3":
        if _s3 is None:
            _s3 = boto3.client("s3", **client_kwargs)
        return _s3
    return boto3.client(name, **client_kwargs)


# --- Config from environment ------------------------------------------------
SAGEMAKER_ENDPOINT = os.getenv("SAGEMAKER_ENDPOINT")  # realtime endpoint name
SAGEMAKER_TRANSFORM_ROLE = os.getenv("SAGEMAKER_TRANSFORM_ROLE")
SAGEMAKER_MODEL_NAME = os.getenv("SAGEMAKER_MODEL_NAME", "whisper-model")
TRANSFORM_OUTPUT_BUCKET = os.getenv("TRANSFORM_OUTPUT_BUCKET")  # e.g., "s3://my-bucket/path-prefix" or "my-bucket/path-prefix"
SAGEMAKER_TRANSFORM_INSTANCE_TYPE = os.getenv("SAGEMAKER_TRANSFORM_INSTANCE_TYPE", "ml.g4dn.xlarge")
# default as int; handle env which will be string
try:
    MAX_REALTIME_BYTES = int(os.getenv("MAX_REALTIME_BYTES", str(5 * 1024 * 1024)))
except Exception:
    MAX_REALTIME_BYTES = 5 * 1024 * 1024  # fallback 5MB

# Polling/backoff configuration for transform waits
try:
    TRANSFORM_POLL_INTERVAL = int(os.getenv("TRANSFORM_POLL_INTERVAL", "10"))
except Exception:
    TRANSFORM_POLL_INTERVAL = 10
try:
    TRANSFORM_POLL_MAX_BACKOFF = int(os.getenv("TRANSFORM_POLL_MAX_BACKOFF", "60"))
except Exception:
    TRANSFORM_POLL_MAX_BACKOFF = 60

# --- Utilities --------------------------------------------------------------
EMAIL_RE = re.compile(r"[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+")
PHONE_RE = re.compile(r"(?:\+?\d{1,3}[-.\s]?)?(?:\(?\d{2,4}\)?[-.\s]?)?\d{3,4}[-.\s]?\d{3,4}")


def redact_pii(text: str) -> str:
    """
    Basic redaction of emails and phone numbers. Replace with production detector where required.
    """
    if not isinstance(text, str):
        return text
    redacted = EMAIL_RE.sub("[REDACTED_EMAIL]", text)
    redacted = PHONE_RE.sub("[REDACTED_PHONE]", redacted)
    return redacted


def parse_s3_uri(s3_uri: str) -> Tuple[str, str]:
    """
    Accepts formats:
      - s3://bucket/key...
      - bucket/key...
    Returns (bucket, key)
    """
    if not isinstance(s3_uri, str) or not s3_uri:
        raise ValueError("s3_uri must be a non-empty string")
    if s3_uri.startswith("s3://"):
        path = s3_uri[5:]
    else:
        path = s3_uri
    if "/" not in path:
        raise ValueError(f"s3_uri must include a key/prefix after bucket: {s3_uri}")
    bucket, key = path.split("/", 1)
    return bucket, key


def _ensure_transform_output_uri(uri: str) -> str:
    """
    Normalize TRANSFORM_OUTPUT_BUCKET into an S3 output path like 's3://bucket/prefix'.
    Raises RuntimeError if missing or malformed.
    """
    if not uri:
        raise RuntimeError("TRANSFORM_OUTPUT_BUCKET is not configured")
    uri = uri.rstrip("/")
    if uri.startswith("s3://"):
        return uri
    # allow 'bucket/prefix' or 'bucket'
    if "/" in uri:
        return f"s3://{uri}"
    return f"s3://{uri}"


# ------------------------- Retry decorator ----------------------------------
def retry_on_exception(
    exceptions: Tuple[type, ...] = (Exception,),
    tries: int = 3,
    initial_delay: float = 0.5,
    backoff: float = 2.0,
    max_delay: float = 10.0,
    logger_fn: Optional[Callable[[str], None]] = None,
):
    """
    Generic retry decorator with exponential backoff for transient errors.
    """
    def deco(f):
        @wraps(f)
        def wrapped(*args, **kwargs):
            delay = initial_delay
            last_exc = None
            for attempt in range(1, tries + 1):
                try:
                    return f(*args, **kwargs)
                except exceptions as e:
                    last_exc = e
                    if logger_fn:
                        logger_fn(f"Attempt {attempt} failed with {e}; retrying in {delay}s")
                    else:
                        logger.debug("Attempt %d failed for %s: %s", attempt, getattr(f, "__name__", f), e)
                    if attempt == tries:
                        break
                    time.sleep(delay)
                    delay = min(delay * backoff, max_delay)
            # final raise
            raise last_exc
        return wrapped
    return deco


# ------------------------- S3 helpers ---------------------------------------
@retry_on_exception((ClientError, ), tries=3, initial_delay=0.5, backoff=2.0, max_delay=5.0, logger_fn=lambda m: logger.debug(m))
def download_s3_to_bytes(bucket: str, key: str) -> bytes:
    s3 = boto_client("s3")
    logger.info("Downloading s3://%s/%s", bucket, key)
    try:
        resp = s3.get_object(Bucket=bucket, Key=key)
        return resp["Body"].read()
    except ClientError as e:
        logger.exception("Failed to download S3 object %s/%s: %s", bucket, key, e)
        raise


@retry_on_exception((ClientError, ), tries=3, initial_delay=0.5, backoff=2.0, max_delay=5.0, logger_fn=lambda m: logger.debug(m))
def upload_bytes_to_s3(data: bytes, bucket: str, key: str, content_type: Optional[str] = None) -> str:
    s3 = boto_client("s3")
    logger.info("Uploading result to s3://%s/%s", bucket, key)
    try:
        kwargs = {"Bucket": bucket, "Key": key, "Body": data}
        if content_type:
            kwargs["ContentType"] = content_type
        s3.put_object(**kwargs)
        return f"s3://{bucket}/{key}"
    except ClientError as e:
        logger.exception("Failed to upload to S3 %s/%s: %s", bucket, key, e)
        raise


@retry_on_exception((ClientError, ), tries=3, initial_delay=0.5, backoff=2.0, max_delay=5.0, logger_fn=lambda m: logger.debug(m))
def list_s3_prefix(bucket: str, prefix: str, max_keys: int = 1000) -> List[Dict[str, Any]]:
    s3 = boto_client("s3")
    logger.debug("Listing s3://%s/%s", bucket, prefix)
    try:
        resp = s3.list_objects_v2(Bucket=bucket, Prefix=prefix, MaxKeys=max_keys)
        return resp.get("Contents", []) or []
    except ClientError as e:
        logger.exception("Failed to list S3 prefix %s/%s: %s", bucket, prefix, e)
        raise


# ------------------------- Real-time inference ------------------------------
@retry_on_exception((ClientError, ), tries=3, initial_delay=0.5, backoff=2.0, max_delay=5.0, logger_fn=lambda m: logger.debug(m))
def transcribe_bytes_realtime(audio_bytes: bytes, content_type: Optional[str] = None) -> Dict:
    """
    Call SageMaker realtime endpoint with raw audio bytes.
    Endpoint must return JSON with 'text' field or plain text body.
    This function is defensive: it tolerates JSON bodies, plain text, or slightly wrapped payloads.
    """
    if not SAGEMAKER_ENDPOINT:
        raise RuntimeError("SAGEMAKER_ENDPOINT is not configured for realtime inference")
    if not _BOTO3_AVAILABLE:
        raise RuntimeError("boto3 is required for realtime inference")

    runtime = boto_client("sagemaker-runtime")
    # try detect content-type if not provided
    content_type = content_type or "audio/wav"
    logger.debug("Invoking realtime endpoint %s (content_type=%s, bytes=%d)", SAGEMAKER_ENDPOINT, content_type, len(audio_bytes))

    try:
        resp = runtime.invoke_endpoint(
            EndpointName=SAGEMAKER_ENDPOINT,
            ContentType=content_type,
            Body=audio_bytes
        )
        body = resp["Body"].read()
        parsed: Dict[str, Any] = {}
        # Common cases:
        # - JSON with {"text": "...", ...}
        # - plain text transcript
        # - JSONL or nested payloads
        try:
            decoded = body.decode("utf-8", errors="replace")
            parsed_json = json.loads(decoded)
            if isinstance(parsed_json, dict):
                # pick text or transcript-like fields
                text = parsed_json.get("text") or parsed_json.get("transcript") or parsed_json.get("result") or ""
                parsed = {"text": text, "raw": parsed_json}
            else:
                # non-dict json (e.g., list) -> stringify
                parsed = {"text": str(parsed_json), "raw": parsed_json}
        except Exception:
            # not JSON; treat as plaintext
            try:
                text = body.decode("utf-8", errors="replace")
                parsed = {"text": text}
            except Exception:
                parsed = {"text": ""}
        logger.debug("Realtime response parsed: keys=%s", list(parsed.keys()))
        return parsed
    except ClientError as e:
        logger.exception("Realtime inference failed: %s", e)
        raise


# ------------------------- Batch / Transform job ----------------------------
def _make_transform_job_name(prefix: Optional[str] = None) -> str:
    base = prefix or SAGEMAKER_MODEL_NAME or "whisper-model"
    return f"{base}-transform-{int(time.time())}-{uuid.uuid4().hex[:6]}"


@retry_on_exception((ClientError, ), tries=2, initial_delay=1.0, backoff=2.0, max_delay=8.0, logger_fn=lambda m: logger.debug(m))
def start_sagemaker_transform(
    s3_input_uri: str,
    output_s3_uri: str,
    job_name: Optional[str] = None,
    content_type: str = "audio/wav",
    split_type: str = "None",
) -> Dict:
    """
    Start a SageMaker Batch Transform job. The model container should accept S3Prefix inputs
    and write outputs under the given S3OutputPath.
    Returns {'TransformJobName': job_name}
    """
    if not _BOTO3_AVAILABLE:
        raise RuntimeError("boto3 is required to start SageMaker transform jobs")
    if not SAGEMAKER_TRANSFORM_ROLE:
        raise RuntimeError("SAGEMAKER_TRANSFORM_ROLE is not configured for transform jobs")

    job_name = job_name or _make_transform_job_name()
    sm = boto_client("sagemaker")

    transform_input = {
        "DataSource": {"S3DataSource": {"S3DataType": "S3Prefix", "S3Uri": s3_input_uri}},
        "ContentType": content_type,
        "SplitType": split_type
    }

    transform_output = {"S3OutputPath": output_s3_uri}
    transform_resources = {"InstanceType": SAGEMAKER_TRANSFORM_INSTANCE_TYPE, "InstanceCount": 1}

    logger.info("Creating transform job %s (input=%s output=%s)", job_name, s3_input_uri, output_s3_uri)
    try:
        response = sm.create_transform_job(
            TransformJobName=job_name,
            ModelName=SAGEMAKER_MODEL_NAME,
            MaxConcurrentTransforms=1,
            MaxPayloadInMB=50,
            TransformInput=transform_input,
            TransformOutput=transform_output,
            TransformResources=transform_resources,
            Tags=[{"Key": "project", "Value": "speech-to-insights"}]
        )
        logger.debug("CreateTransformJob response: %s", response)
        return {"TransformJobName": job_name}
    except ClientError as e:
        logger.exception("Failed to create transform job: %s", e)
        raise


def wait_for_transform(
    job_name: str,
    poll_interval: Optional[int] = None,
    timeout_seconds: int = 60 * 60 * 2,
    max_backoff: Optional[int] = None,
) -> Dict:
    """
    Polls SageMaker transform job status until terminal state. Returns final describe_transform_job dict.
    Uses exponential backoff up to max_backoff.
    """
    if not _BOTO3_AVAILABLE:
        raise RuntimeError("boto3 is required to poll SageMaker transform jobs")
    sm = boto_client("sagemaker")
    poll_interval = poll_interval or TRANSFORM_POLL_INTERVAL
    max_backoff = max_backoff or TRANSFORM_POLL_MAX_BACKOFF

    start = time.time()
    attempt = 0
    while True:
        try:
            resp = sm.describe_transform_job(TransformJobName=job_name)
        except ClientError as e:
            logger.exception("describe_transform_job failed for %s: %s", job_name, e)
            # treat as transient and retry
            resp = {}
        status = resp.get("TransformJobStatus")
        logger.info("Transform %s status=%s", job_name, status)
        if status in ("Completed", "Failed", "Stopped"):
            return resp
        if time.time() - start > timeout_seconds:
            raise TimeoutError(f"Transform job {job_name} did not complete within {timeout_seconds}s")
        # exponential backoff with jitter
        attempt += 1
        delay = min(max_backoff, poll_interval * (2 ** (attempt - 1)))
        # add a small jitter
        delay = delay * (0.8 + 0.4 * (uuid.uuid4().int % 100) / 100.0)
        logger.debug("Sleeping %0.1fs before next transform poll (attempt=%d)", delay, attempt)
        time.sleep(delay)


def _read_transform_outputs_from_s3(output_s3_uri: str, job_name_hint: Optional[str] = None, max_files: int = 50) -> List[Dict[str, Any]]:
    """
    List and fetch transform output objects under output_s3_uri, returning parsed JSON/text results.
    output_s3_uri should be like 's3://bucket/prefix' or 'bucket/prefix' (we normalize).
    If job_name_hint is provided, we attempt to filter keys containing the job_name_hint.
    """
    out_uri = _ensure_transform_output_uri(output_s3_uri)
    bucket, prefix = parse_s3_uri(out_uri)
    # list objects under prefix
    objs = list_s3_prefix(bucket, prefix)
    results = []
    count = 0
    for o in objs:
        key = o.get("Key")
        if not key:
            continue
        if job_name_hint and job_name_hint not in key:
            # still include, but prefer hinted keys
            pass
        if count >= max_files:
            break
        try:
            raw = download_s3_to_bytes(bucket, key)
            # attempt to parse JSON/JSONL, else decode text
            parsed = None
            try:
                parsed = json.loads(raw.decode("utf-8"))
            except Exception:
                # try first line JSON (jsonl)
                try:
                    txt = raw.decode("utf-8", errors="replace")
                    first = txt.splitlines()[0].strip()
                    parsed = json.loads(first)
                except Exception:
                    parsed = txt
            results.append({"s3_key": key, "content": parsed})
            count += 1
        except Exception:
            logger.exception("Failed to fetch/parse transform output s3://%s/%s", bucket, key)
    return results


# ------------------------- Orchestration ------------------------------------
def process_s3_event_and_transcribe(record: Dict, use_realtime_threshold: Optional[int] = None, wait_for_transform_completion: bool = False) -> Dict:
    """
    Handle a single S3 event record. Downloads audio, decides realtime vs transform,
    runs transcription, returns a dict with result metadata.

    If wait_for_transform_completion is True, the function will wait for transform to finish and
    fetch outputs from TRANSFORM_OUTPUT_BUCKET (if configured) and include them in the response.
    """
    try:
        bucket = record["s3"]["bucket"]["name"]
        key = record["s3"]["object"]["key"]
    except Exception:
        raise ValueError("Invalid S3 event record structure; expected record['s3']['bucket']['name'] and ['object']['key']")

    # Prefer the explicit object size if provided
    size = None
    try:
        obj_meta = record["s3"].get("object", {})
        if isinstance(obj_meta, dict) and obj_meta.get("size") is not None:
            size = int(obj_meta.get("size"))
    except Exception:
        size = None

    logger.info("Processing S3 object s3://%s/%s (size=%s)", bucket, key, size)
    audio_bytes = download_s3_to_bytes(bucket, key)
    audio_len = len(audio_bytes)
    threshold = use_realtime_threshold if use_realtime_threshold is not None else MAX_REALTIME_BYTES

    timestamp = time.time()

    # Realtime path
    if audio_len <= threshold and SAGEMAKER_ENDPOINT:
        logger.info("Choosing realtime inference (size %d <= %d)", audio_len, threshold)
        out = transcribe_bytes_realtime(audio_bytes)
        text = out.get("text", "")
        redacted = redact_pii(text)
        result = {
            "source_s3": f"s3://{bucket}/{key}",
            "mode": "realtime",
            "transcript": text,
            "transcript_redacted": redacted,
            "meta": out,
            "timestamp": timestamp
        }
        return result

    # Batch transform path
    output_uri = _ensure_transform_output_uri(TRANSFORM_OUTPUT_BUCKET)
    s3_input = f"s3://{bucket}/{key}"
    logger.info("Choosing batch transform path for %s -> output %s", s3_input, output_uri)
    job = start_sagemaker_transform(s3_input, output_uri)
    result = {
        "source_s3": s3_input,
        "mode": "transform",
        "transform_job": job,
        "timestamp": timestamp
    }

    if wait_for_transform_completion:
        job_name = job.get("TransformJobName")
        try:
            describe = wait_for_transform(job_name)
            result["transform_status"] = describe.get("TransformJobStatus")
            # attempt to read outputs under output_uri
            try:
                outputs = _read_transform_outputs_from_s3(output_uri, job_name_hint=job_name, max_files=20)
                result["transform_outputs"] = outputs
            except Exception:
                logger.exception("Failed to fetch transform outputs from %s", output_uri)
        except Exception:
            logger.exception("Waiting for transform %s failed", job.get("TransformJobName"))
            result["transform_wait_error"] = "wait_failed"

    return result


# ------------------------- Lambda entrypoint --------------------------------
def lambda_handler(event, context):
    """
    Lambda entrypoint.

    Supported event shapes:
    - S3 Put event (S3 -> Lambda): handle each record and return summary.
    - Direct invoke with {"s3_bucket": "...", "s3_key": "..."} or {"audio_base64": "..."}.
    - Optional boolean "wait_for_transform" in direct S3 invocation to wait & fetch outputs.
    """
    logger.info("Lambda invoked. Event keys: %s", list(event.keys()) if isinstance(event, dict) else str(type(event)))

    results = []

    # S3 event records
    if isinstance(event, dict) and event.get("Records") and isinstance(event["Records"], list) and event["Records"][0].get("s3"):
        logger.info("Detected S3 event with %d records", len(event["Records"]))
        for rec in event["Records"]:
            try:
                # safe: if user set wait_for_transform flag in root event, propagate
                wait_flag = bool(event.get("wait_for_transform", False))
                res = process_s3_event_and_transcribe(rec, wait_for_transform_completion=wait_flag)
                results.append({"ok": True, "result": res})
            except Exception as e:
                logger.exception("Failed processing record: %s", e)
                results.append({"ok": False, "error": str(e)})
        return {"results": results}

    # Direct S3 invocation shape
    if isinstance(event, dict) and "s3_bucket" in event and "s3_key" in event:
        rec_like = {"s3": {"bucket": {"name": event["s3_bucket"]}, "object": {"key": event["s3_key"]}}}
        try:
            wait_flag = bool(event.get("wait_for_transform", False))
            res = process_s3_event_and_transcribe(rec_like, wait_for_transform_completion=wait_flag)
            return {"ok": True, "result": res}
        except Exception as e:
            logger.exception("Direct S3 processing failed: %s", e)
            return {"ok": False, "error": str(e)}

    # Direct audio bytes (base64)
    if isinstance(event, dict) and "audio_base64" in event:
        try:
            audio_bytes = base64.b64decode(event["audio_base64"])
            if not SAGEMAKER_ENDPOINT:
                raise RuntimeError("SAGEMAKER_ENDPOINT not configured for realtime inference")
            content_type = event.get("content_type")
            out = transcribe_bytes_realtime(audio_bytes, content_type=content_type)
            text = out.get("text", "")
            return {"ok": True, "transcript": text, "transcript_redacted": redact_pii(text)}
        except Exception as e:
            logger.exception("Direct audio processing failed: %s", e)
            return {"ok": False, "error": str(e)}

    # Unknown shape
    logger.error("Unsupported event shape for whisper.lambda_handler")
    raise ValueError("Unsupported event shape for whisper.lambda_handler")


# ------------------------- CLI for local testing ----------------------------
if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Local test runner for whisper.py (upgraded)")
    parser.add_argument("--s3", help="S3 URI (s3://bucket/key) to process")
    parser.add_argument("--file", help="Local audio file to process")
    parser.add_argument("--mode", choices=["realtime", "transform", "auto"], default="auto")
    parser.add_argument("--wait", action="store_true", help="Wait for transform completion and fetch outputs (when using transform)")
    args = parser.parse_args()

    if not (args.s3 or args.file):
        parser.error("Either --s3 or --file must be provided")

    if args.file:
        with open(args.file, "rb") as fh:
            b = fh.read()
        # simple content-type guess
        guessed_ct, _ = mimetypes.guess_type(args.file)
        content_type = guessed_ct or "audio/wav"
        use_realtime = False
        if args.mode == "realtime":
            use_realtime = True
        elif args.mode == "auto":
            use_realtime = (len(b) <= MAX_REALTIME_BYTES and SAGEMAKER_ENDPOINT is not None)
        if use_realtime:
            print("Invoking realtime endpoint...")
            out = transcribe_bytes_realtime(b, content_type=content_type)
            print(json.dumps(out, indent=2))
        else:
            # Upload to temporary s3 then start transform
            if not _BOTO3_AVAILABLE:
                raise RuntimeError("boto3 is required to run transform locally")
            s3 = boto_client("s3")
            output_uri = _ensure_transform_output_uri(TRANSFORM_OUTPUT_BUCKET)
            tmp_bucket, _ = parse_s3_uri(output_uri)
            uploads_prefix = f"local-tests-input/{uuid.uuid4().hex}/"
            s3_input_key = uploads_prefix + os.path.basename(args.file)
            logger.info("Uploading local file to s3://%s/%s", tmp_bucket, s3_input_key)
            s3.put_object(Bucket=tmp_bucket, Key=s3_input_key, Body=b)
            s3_input_uri = f"s3://{tmp_bucket}/{s3_input_key}"
            job = start_sagemaker_transform(s3_input_uri, output_uri)
            print(json.dumps(job, indent=2))
            if args.wait:
                job_name = job.get("TransformJobName")
                print("Waiting for transform to complete...", job_name)
                describe = wait_for_transform(job_name)
                print(json.dumps(describe, indent=2))
                try:
                    outputs = _read_transform_outputs_from_s3(output_uri, job_name_hint=job_name, max_files=20)
                    print("Found outputs:", json.dumps(outputs, indent=2))
                except Exception:
                    logger.exception("Failed to fetch outputs after transform")
