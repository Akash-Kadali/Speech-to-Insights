"""
backend/whisper.py

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
"""

from __future__ import annotations

import os
import json
import base64
import logging
import re
import time
import uuid
from typing import Optional, Dict, Tuple

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
logger.setLevel(os.getenv("LOG_LEVEL", "INFO"))
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
    if name == "sagemaker-runtime":
        if _sagemaker_runtime is None:
            _sagemaker_runtime = boto3.client("sagemaker-runtime", **kwargs)
        return _sagemaker_runtime
    if name == "sagemaker":
        if _sagemaker is None:
            _sagemaker = boto3.client("sagemaker", **kwargs)
        return _sagemaker
    if name == "s3":
        if _s3 is None:
            _s3 = boto3.client("s3", **kwargs)
        return _s3
    return boto3.client(name, **kwargs)


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


# ------------------------- S3 helpers ---------------------------------------
def download_s3_to_bytes(bucket: str, key: str) -> bytes:
    s3 = boto_client("s3")
    logger.info("Downloading s3://%s/%s", bucket, key)
    try:
        resp = s3.get_object(Bucket=bucket, Key=key)
        return resp["Body"].read()
    except ClientError as e:
        logger.exception("Failed to download S3 object %s/%s: %s", bucket, key, e)
        raise


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


# ------------------------- Real-time inference ------------------------------
def transcribe_bytes_realtime(audio_bytes: bytes, content_type: str = "audio/wav") -> Dict:
    """
    Call SageMaker realtime endpoint with raw audio bytes.
    Endpoint must return JSON with 'text' field or plain text body.
    """
    if not SAGEMAKER_ENDPOINT:
        raise RuntimeError("SAGEMAKER_ENDPOINT is not configured for realtime inference")
    if not _BOTO3_AVAILABLE:
        raise RuntimeError("boto3 is required for realtime inference")

    runtime = boto_client("sagemaker-runtime")
    logger.debug("Invoking realtime endpoint %s (content_type=%s, bytes=%d)", SAGEMAKER_ENDPOINT, content_type, len(audio_bytes))

    try:
        resp = runtime.invoke_endpoint(
            EndpointName=SAGEMAKER_ENDPOINT,
            ContentType=content_type,
            Body=audio_bytes
        )
        body = resp["Body"].read()
        try:
            parsed = json.loads(body.decode("utf-8"))
        except Exception:
            parsed = {"text": body.decode("utf-8", errors="replace")}
        logger.debug("Realtime response: %s", parsed)
        return parsed
    except ClientError as e:
        logger.exception("Realtime inference failed: %s", e)
        raise


# ------------------------- Batch / Transform job ----------------------------
def start_sagemaker_transform(s3_input_uri: str, output_s3_uri: str, job_name: Optional[str] = None,
                              content_type: str = "audio/wav", split_type: str = "None") -> Dict:
    """
    Start a SageMaker Batch Transform job. The model container should accept S3Prefix inputs
    and write outputs under the given S3OutputPath.
    """
    if not _BOTO3_AVAILABLE:
        raise RuntimeError("boto3 is required to start SageMaker transform jobs")
    if not SAGEMAKER_TRANSFORM_ROLE:
        raise RuntimeError("SAGEMAKER_TRANSFORM_ROLE is not configured for transform jobs")

    job_name = job_name or f"{SAGEMAKER_MODEL_NAME}-transform-{int(time.time())}-{uuid.uuid4().hex[:6]}"
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


def wait_for_transform(job_name: str, poll_interval: int = 10, timeout_seconds: int = 60 * 60 * 2) -> Dict:
    """
    Polls SageMaker transform job status until terminal state. Returns final describe_transform_job dict.
    """
    if not _BOTO3_AVAILABLE:
        raise RuntimeError("boto3 is required to poll SageMaker transform jobs")
    sm = boto_client("sagemaker")
    start = time.time()
    while True:
        resp = sm.describe_transform_job(TransformJobName=job_name)
        status = resp.get("TransformJobStatus")
        logger.info("Transform %s status=%s", job_name, status)
        if status in ("Completed", "Failed", "Stopped"):
            return resp
        if time.time() - start > timeout_seconds:
            raise TimeoutError(f"Transform job {job_name} did not complete within {timeout_seconds}s")
        time.sleep(poll_interval)


# ------------------------- Orchestration ------------------------------------
def process_s3_event_and_transcribe(record: Dict, use_realtime_threshold: Optional[int] = None) -> Dict:
    """
    Handle a single S3 event record. Downloads audio, decides realtime vs transform,
    runs transcription, returns a dict with result metadata.
    """
    try:
        bucket = record["s3"]["bucket"]["name"]
        key = record["s3"]["object"]["key"]
    except Exception:
        raise ValueError("Invalid S3 event record structure; expected record['s3']['bucket']['name'] and ['object']['key']")

    # Prefer the explicit object size if provided
    size = None
    try:
        size = int(record["s3"]["object"].get("size")) if "object" in record.get("s3", {}) and record["s3"]["object"].get("size") is not None else None
    except Exception:
        size = None

    logger.info("Processing S3 object s3://%s/%s (size=%s)", bucket, key, size)
    audio_bytes = download_s3_to_bytes(bucket, key)
    audio_len = len(audio_bytes)
    threshold = use_realtime_threshold if use_realtime_threshold is not None else MAX_REALTIME_BYTES

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
            "meta": out
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
        "transform_job": job
    }
    return result


# ------------------------- Lambda entrypoint --------------------------------
def lambda_handler(event, context):
    """
    Lambda entrypoint.

    Supported event shapes:
    - S3 Put event (S3 -> Lambda): handle each record and return summary.
    - Direct invoke with {"s3_bucket": "...", "s3_key": "..."} or {"audio_base64": "..."}.
    """
    logger.info("Lambda invoked. Event keys: %s", list(event.keys()) if isinstance(event, dict) else str(type(event)))

    results = []

    # S3 event records
    if isinstance(event, dict) and event.get("Records") and isinstance(event["Records"], list) and event["Records"][0].get("s3"):
        logger.info("Detected S3 event with %d records", len(event["Records"]))
        for rec in event["Records"]:
            try:
                res = process_s3_event_and_transcribe(rec)
                results.append({"ok": True, "result": res})
            except Exception as e:
                logger.exception("Failed processing record: %s", e)
                results.append({"ok": False, "error": str(e)})
        return {"results": results}

    # Direct S3 invocation shape
    if isinstance(event, dict) and "s3_bucket" in event and "s3_key" in event:
        rec_like = {"s3": {"bucket": {"name": event["s3_bucket"]}, "object": {"key": event["s3_key"]}}}
        try:
            res = process_s3_event_and_transcribe(rec_like)
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
            out = transcribe_bytes_realtime(audio_bytes)
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

    parser = argparse.ArgumentParser(description="Local test runner for whisper.py")
    parser.add_argument("--s3", help="S3 URI (s3://bucket/key) to process")
    parser.add_argument("--file", help="Local audio file to process")
    parser.add_argument("--mode", choices=["realtime", "transform", "auto"], default="auto")
    args = parser.parse_args()

    if not (args.s3 or args.file):
        parser.error("Either --s3 or --file must be provided")

    if args.file:
        with open(args.file, "rb") as fh:
            b = fh.read()
        if args.mode == "realtime" or (args.mode == "auto" and len(b) <= MAX_REALTIME_BYTES and SAGEMAKER_ENDPOINT):
            out = transcribe_bytes_realtime(b)
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
