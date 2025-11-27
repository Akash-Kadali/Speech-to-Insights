"""
backend/handlers.py

Enhanced orchestration helpers used by API, Lambda handlers, and tests.

Purpose
- Centralize upload, S3, and workflow-start logic so routes.py and lambda_handlers.py
  remain thin.
- Provide deterministic, testable functions:
    * handle_upload_fileobj(fileobj, filename, start_workflow=False, presign=False, content_type=None)
    * handle_s3_event_record(record)
    * start_workflow_for_s3_uri(s3_uri, run_id=None)
    * fetch_result_if_exists(run_id)
    * postprocess_transcript_and_redact(transcript_text, redact=True)
- Best-effort use of local modules (transcribe, whisper, step_fn_handlers, pii_detector).
- Uses env vars:
    TRANSFORM_INPUT_BUCKET, TRANSFORM_INPUT_PREFIX, STATE_MACHINE_ARN,
    OUTPUT_S3_BUCKET, OUTPUT_S3_PREFIX, MAX_REALTIME_BYTES, PRESIGN_URL_EXPIRES

Design notes
- Conservative: logs and returns structured results instead of raising for most recoverable failures.
- Small CLI for local smoke tests.
"""

from __future__ import annotations

import os
import uuid
import json
import logging
import time
from typing import Dict, Any, Optional, Tuple, IO

import boto3
from botocore.exceptions import ClientError

logger = logging.getLogger("handlers")
logger.setLevel(os.getenv("LOG_LEVEL", "INFO"))

# Best-effort imports of local integrations
try:
    from . import transcribe as transcribe_module  # type: ignore
except Exception:
    transcribe_module = None  # type: ignore

try:
    from . import whisper as whisper_module  # type: ignore
except Exception:
    whisper_module = None  # type: ignore

try:
    from . import step_fn_handlers as sf_handlers  # type: ignore
except Exception:
    sf_handlers = None  # type: ignore

try:
    from . import pii_detector as pii_detector  # type: ignore
except Exception:
    pii_detector = None  # type: ignore

# Environment-configured defaults
TRANSFORM_INPUT_BUCKET = os.getenv("TRANSFORM_INPUT_BUCKET")
TRANSFORM_INPUT_PREFIX = os.getenv("TRANSFORM_INPUT_PREFIX", "inputs").strip("/")
STATE_MACHINE_ARN = os.getenv("STATE_MACHINE_ARN")
OUTPUT_S3_BUCKET = os.getenv("OUTPUT_S3_BUCKET")
OUTPUT_S3_PREFIX = os.getenv("OUTPUT_S3_PREFIX", "outputs").strip("/")
MAX_REALTIME_BYTES = int(os.getenv("MAX_REALTIME_BYTES", "5242880"))  # 5MB
PRESIGN_URL_EXPIRES = int(os.getenv("PRESIGN_URL_EXPIRES", "900"))

# boto3 clients
_s3 = boto3.client("s3")
_sfn = boto3.client("stepfunctions")


# -------------------------
# Low-level S3 helpers
# -------------------------
def _s3_key_for_upload(filename: str, run_id: Optional[str] = None, prefix: Optional[str] = None) -> str:
    run_id = run_id or uuid.uuid4().hex
    prefix = (prefix or TRANSFORM_INPUT_PREFIX).rstrip("/")
    safe_name = filename.replace(" ", "_")
    return f"{prefix}/{run_id}/{safe_name}"


def _upload_fileobj(fileobj: IO[bytes], bucket: str, key: str, content_type: Optional[str] = None) -> str:
    """
    Upload file-like object to S3 and return s3:// URI.
    Will attempt to rewind fileobj if possible.
    """
    try:
        try:
            fileobj.seek(0)
        except Exception:
            pass
        extra = {"ContentType": content_type} if content_type else {}
        _s3.upload_fileobj(fileobj, bucket, key, ExtraArgs=extra)
        uri = f"s3://{bucket}/{key}"
        logger.info("Uploaded file to %s", uri)
        return uri
    except ClientError as exc:
        logger.exception("S3 upload failed for %s/%s", bucket, key)
        raise


def _upload_bytes_to_s3(data: bytes, bucket: str, key: str, content_type: Optional[str] = None) -> str:
    try:
        extra = {"ContentType": content_type} if content_type else {}
        _s3.put_object(Bucket=bucket, Key=key, Body=data, **extra)
        uri = f"s3://{bucket}/{key}"
        logger.info("Uploaded bytes to %s (size=%d)", uri, len(data))
        return uri
    except ClientError:
        logger.exception("S3 put_object failed for %s/%s", bucket, key)
        raise


def _head_object(bucket: str, key: str) -> Dict[str, Any]:
    try:
        return _s3.head_object(Bucket=bucket, Key=key)
    except ClientError as exc:
        logger.debug("S3 head_object failed for %s/%s: %s", bucket, key, exc)
        return {}


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


# -------------------------
# High-level flows
# -------------------------
def handle_upload_fileobj(fileobj: IO[bytes],
                          filename: str,
                          start_workflow: bool = False,
                          presign: bool = False,
                          content_type: Optional[str] = None,
                          run_id: Optional[str] = None) -> Dict[str, Any]:
    """
    Upload a file-like object or provide presigned URL.

    Returns a dict:
      {
        "ok": True/False,
        "upload_id": run_id,
        "s3_uri": ...,
        "s3_bucket": ...,
        "s3_key": ...,
        "status": "uploaded"|"processing_realtime"|"workflow_started"|"presigned",
        "meta": {...},
        "error": "..."   # on failure
      }
    """
    if presign:
        if not TRANSFORM_INPUT_BUCKET:
            return {"ok": False, "error": "TRANSFORM_INPUT_BUCKET not configured for presign"}
        run_id = run_id or uuid.uuid4().hex
        key = _s3_key_for_upload(filename, run_id=run_id)
        try:
            presign = _generate_presigned_put(TRANSFORM_INPUT_BUCKET, key, expires_in=PRESIGN_URL_EXPIRES, content_type=content_type)
            return {"ok": True, "upload_id": run_id, "status": "presigned", "result": presign}
        except Exception as exc:
            return {"ok": False, "error": f"presign_failed: {exc}"}

    if not TRANSFORM_INPUT_BUCKET:
        logger.error("TRANSFORM_INPUT_BUCKET is not configured")
        return {"ok": False, "error": "TRANSFORM_INPUT_BUCKET not configured"}

    run_id = run_id or uuid.uuid4().hex
    key = _s3_key_for_upload(filename, run_id=run_id)

    try:
        s3_uri = _upload_fileobj(fileobj, TRANSFORM_INPUT_BUCKET, key, content_type=content_type)
    except Exception as exc:
        return {"ok": False, "error": f"s3_upload_failed: {exc}"}

    # Decide realtime vs batch by object size
    head = _head_object(TRANSFORM_INPUT_BUCKET, key)
    size = head.get("ContentLength")
    result: Dict[str, Any] = {
        "ok": True,
        "upload_id": run_id,
        "s3_uri": s3_uri,
        "s3_bucket": TRANSFORM_INPUT_BUCKET,
        "s3_key": key,
        "status": "uploaded"
    }

    # Inline realtime transcription for small files if whisper available
    try:
        if size is not None and size <= MAX_REALTIME_BYTES and whisper_module and getattr(whisper_module, "transcribe_bytes_realtime", None):
            try:
                resp = _s3.get_object(Bucket=TRANSFORM_INPUT_BUCKET, Key=key)
                audio_bytes = resp["Body"].read()
                out = whisper_module.transcribe_bytes_realtime(audio_bytes)
                result["status"] = "processing_realtime"
                result["transcript"] = out.get("text", "")
                result["meta"] = out
                logger.info("Realtime transcription completed for %s", key)
                return result
            except Exception:
                logger.exception("Realtime transcription failed for %s; returning upload info", key)
                result["note"] = "realtime_failed"
    except Exception:
        logger.exception("Error while deciding realtime vs transform")

    # Optionally start Step Functions workflow
    if start_workflow and sf_handlers and STATE_MACHINE_ARN:
        try:
            exec_resp = sf_handlers.start_state_machine_execution({"audio_s3_uri": s3_uri, "run_id": run_id})
            result["status"] = "workflow_started"
            result["workflow"] = exec_resp
            return result
        except Exception:
            logger.exception("Failed to start workflow; returning upload info")
            result["note"] = "workflow_start_failed"

    return result


def handle_s3_event_record(record: Dict[str, Any]) -> Dict[str, Any]:
    """
    Process a single S3 event record.

    Delegates to whisper.process_s3_event_and_transcribe when available,
    otherwise falls back to transcribe_module.transcribe_s3_uri when present.
    """
    try:
        s3_info = record.get("s3", {})
        bucket = s3_info.get("bucket", {}).get("name")
        key = s3_info.get("object", {}).get("key")
        if not bucket or not key:
            logger.warning("Invalid S3 record: missing bucket/key")
            return {"ok": False, "error": "invalid_record"}

        logger.info("Handling S3 event for s3://%s/%s", bucket, key)

        if whisper_module and getattr(whisper_module, "process_s3_event_and_transcribe", None):
            try:
                res = whisper_module.process_s3_event_and_transcribe(record)
                return {"ok": True, "handler": "whisper", "result": res}
            except Exception:
                logger.exception("whisper processing failed; trying fallback")

        if transcribe_module and getattr(transcribe_module, "transcribe_s3_uri", None):
            try:
                s3_uri = f"s3://{bucket}/{key}"
                res = transcribe_module.transcribe_s3_uri(s3_uri)
                return {"ok": True, "handler": "transcribe", "result": res}
            except Exception:
                logger.exception("transcribe.transcribe_s3_uri failed")
                return {"ok": False, "error": "transcription_failed"}

        logger.error("No transcription handler available")
        return {"ok": False, "error": "no_transcription_handler"}
    except Exception as exc:
        logger.exception("Unexpected error handling s3 event record")
        return {"ok": False, "error": str(exc)}


def start_workflow_for_s3_uri(s3_uri: str, run_id: Optional[str] = None) -> Dict[str, Any]:
    """
    Start Step Functions for a given s3 input.
    Returns {"ok": True, "execution": {...}} or {"ok": False, "error": "..."}
    """
    if not STATE_MACHINE_ARN:
        return {"ok": False, "error": "STATE_MACHINE_ARN not configured"}
    if not sf_handlers or not getattr(sf_handlers, "start_state_machine_execution", None):
        return {"ok": False, "error": "step_fn_handlers not available"}

    run_id = run_id or uuid.uuid4().hex
    try:
        exec_resp = sf_handlers.start_state_machine_execution({"audio_s3_uri": s3_uri, "run_id": run_id})
        return {"ok": True, "execution": exec_resp}
    except Exception as exc:
        logger.exception("Failed to start workflow for %s", s3_uri)
        return {"ok": False, "error": str(exc)}


def fetch_result_if_exists(run_id: str) -> Dict[str, Any]:
    """
    Try to fetch final result JSON for run_id from OUTPUT_S3_BUCKET/OUTPUT_S3_PREFIX/run_id/result.json.

    Returns:
      {"ok": True, "found": True, "result": {...}} or {"ok": True, "found": False} or {"ok": False, "error": "..."}
    """
    if not OUTPUT_S3_BUCKET:
        return {"ok": False, "error": "OUTPUT_S3_BUCKET not configured"}

    key = f"{OUTPUT_S3_PREFIX.rstrip('/')}/{run_id}/result.json"
    try:
        resp = _s3.get_object(Bucket=OUTPUT_S3_BUCKET, Key=key)
        body = resp["Body"].read()
        try:
            obj = json.loads(body.decode("utf-8"))
            return {"ok": True, "found": True, "result": obj}
        except Exception:
            return {"ok": True, "found": True, "result_raw": body.decode("utf-8", errors="replace")}
    except ClientError as exc:
        code = exc.response.get("Error", {}).get("Code", "")
        if code in ("NoSuchKey", "404", "NoSuchBucket"):
            return {"ok": True, "found": False}
        logger.exception("S3 error while fetching result for run_id %s", run_id)
        return {"ok": False, "error": str(exc)}


# -------------------------
# Post-processing helpers
# -------------------------
def postprocess_transcript_and_redact(transcript_text: str, redact: bool = True) -> Dict[str, Any]:
    """
    Run optional PII detection and redaction on a transcript.
    Returns:
      {"original": str, "redacted": str (if redact), "pii_report": {...}}
    """
    out: Dict[str, Any] = {"original": transcript_text}
    try:
        if pii_detector and getattr(pii_detector, "detect_pii", None):
            report = pii_detector.detect_pii(transcript_text)
        else:
            report = {"entities": []}
        out["pii_report"] = report

        if redact:
            if pii_detector and getattr(pii_detector, "redact_pii", None):
                redacted, _ = pii_detector.redact_pii(transcript_text)
                out["redacted"] = redacted
            else:
                out["redacted"] = transcript_text
    except Exception:
        logger.exception("PII detection/redaction failed")
        out["pii_report"] = {"error": "pii_detection_failed"}
        if redact:
            out["redacted"] = transcript_text
    return out


# -------------------------
# CLI for quick local tests
# -------------------------
def _cli():
    import argparse
    parser = argparse.ArgumentParser(description="Handlers utility CLI for quick local tests.")
    sub = parser.add_subparsers(dest="cmd", required=True)

    up = sub.add_parser("upload", help="Upload a local file to TRANSFORM_INPUT_BUCKET")
    up.add_argument("--file", required=True, help="Path to local file")
    up.add_argument("--start-workflow", action="store_true", help="Start Step Functions after upload")
    up.add_argument("--presign", action="store_true", help="Return presigned PUT URL instead of uploading")

    s3rec = sub.add_parser("s3-event", help="Process a minimal S3 event record")
    s3rec.add_argument("--bucket", required=True)
    s3rec.add_argument("--key", required=True)

    get = sub.add_parser("get-result", help="Fetch result.json for run_id if exists")
    get.add_argument("--run-id", required=True)

    args = parser.parse_args()

    if args.cmd == "upload":
        if args.presign:
            res = handle_upload_fileobj(fileobj=None, filename=args.file.split("/")[-1], presign=True)
            print(json.dumps(res, indent=2))
            return
        with open(args.file, "rb") as fh:
            res = handle_upload_fileobj(fh, filename=args.file.split("/")[-1], start_workflow=args.start_workflow)
            print(json.dumps(res, indent=2))
    elif args.cmd == "s3-event":
        rec = {"s3": {"bucket": {"name": args.bucket}, "object": {"key": args.key}}}
        res = handle_s3_event_record(rec)
        print(json.dumps(res, indent=2))
    elif args.cmd == "get-result":
        res = fetch_result_if_exists(args.run_id)
        print(json.dumps(res, indent=2))


if __name__ == "__main__":
    _cli()
