"""
backend/routes.py

FastAPI routes for the speech_to_insights project.

Upgrades / new features included:
- POST /upload : accept multipart audio upload, store to S3 input bucket, and either:
    * kick off background realtime transcription for small files,
    * return an s3_uri and optionally start a Step Functions execution.
- POST /start-workflow : start an orchestration run (Step Functions) given an s3_uri or JSON body.
- GET /health : lightweight health check
- GET /presign : create a presigned S3 PUT URL for client uploads (supports content_type and expires_in)
- GET /status/{upload_id} : check for final result.json in OUTPUT_S3_BUCKET
- Better error handling, logging, size checks, and optional immediate workflow start

Environment variables used:
- TRANSFORM_INPUT_BUCKET     : required for uploads
- TRANSFORM_INPUT_PREFIX     : optional prefix in bucket
- STATE_MACHINE_ARN         : optional Step Functions ARN to start runs
- OUTPUT_S3_BUCKET          : optional output bucket for results
- MAX_REALTIME_BYTES        : optional override for realtime threshold (bytes)
- LOG_LEVEL                 : logging level
"""

from __future__ import annotations

import os
import uuid
import json
import logging
from typing import Optional

import boto3
from botocore.exceptions import ClientError

from fastapi import FastAPI, File, UploadFile, HTTPException, BackgroundTasks, Query, Body
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware

# local pipeline imports (best-effort; tests will skip if not present)
try:
    from . import transcribe as transcribe_module
except Exception:
    transcribe_module = None

try:
    from . import step_fn_handlers as sf_handlers
except Exception:
    sf_handlers = None

logger = logging.getLogger("routes")
log_level = os.getenv("LOG_LEVEL", "INFO")
logger.setLevel(log_level)

app = FastAPI(title="speech_to_insights API")

# CORS defaults (adjust in production)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Config
S3_INPUT_BUCKET = (
    os.getenv("TRANSFORM_INPUT_BUCKET")
    or os.getenv("INPUT_S3_BUCKET")
    or os.getenv("TRANSFORM_INPUT_BUCKET_NAME")
)
S3_INPUT_PREFIX = os.getenv("TRANSFORM_INPUT_PREFIX", "inputs")
STATE_MACHINE_ARN = os.getenv("STATE_MACHINE_ARN")
OUTPUT_S3_BUCKET = os.getenv("OUTPUT_S3_BUCKET")
OUTPUT_S3_PREFIX = os.getenv("OUTPUT_S3_PREFIX", "outputs")
MAX_REALTIME_BYTES = int(os.getenv("MAX_REALTIME_BYTES", "5242880"))  # default 5MB

if not S3_INPUT_BUCKET:
    logger.warning("No TRANSFORM_INPUT_BUCKET configured. /upload will fail unless bucket provided.")

# boto3 client
_s3 = boto3.client("s3")


def _s3_key_for_upload(filename: str, prefix: Optional[str] = None, run_id: Optional[str] = None) -> str:
    run_id = run_id or uuid.uuid4().hex
    prefix = (prefix or S3_INPUT_PREFIX).rstrip("/")
    safe_name = filename.replace(" ", "_")
    return f"{prefix}/{run_id}/{safe_name}"


def _upload_fileobj_to_s3(fileobj, bucket: str, key: str, content_type: Optional[str] = None) -> str:
    try:
        extra_args = {"ContentType": content_type} if content_type else None
        # boto3 upload_fileobj supports ExtraArgs with metadata / content type
        if extra_args:
            _s3.upload_fileobj(Fileobj=fileobj, Bucket=bucket, Key=key, ExtraArgs=extra_args)
        else:
            _s3.upload_fileobj(Fileobj=fileobj, Bucket=bucket, Key=key)
    except ClientError as e:
        logger.exception("S3 upload failed: %s", e)
        raise HTTPException(status_code=500, detail=f"S3 upload failed: {e}")
    return f"s3://{bucket}/{key}"


async def _save_upload_and_maybe_transcribe(upload_file: UploadFile, start_workflow: bool, background: BackgroundTasks):
    """
    Save uploaded file to S3 and decide next steps.
    Returns a dict containing upload metadata and at least s3_uri.
    """
    if not S3_INPUT_BUCKET:
        raise HTTPException(status_code=500, detail="Server misconfigured: no TRANSFORM_INPUT_BUCKET")

    run_id = uuid.uuid4().hex
    key = _s3_key_for_upload(upload_file.filename, prefix=S3_INPUT_PREFIX, run_id=run_id)

    # Upload to S3 (UploadFile.file is a SpooledTemporaryFile which is file-like)
    content_type = (upload_file.content_type or None)
    s3_uri = _upload_fileobj_to_s3(upload_file.file, S3_INPUT_BUCKET, key, content_type=content_type)

    result = {
        "upload_id": run_id,
        "s3_uri": s3_uri,
        "s3_bucket": S3_INPUT_BUCKET,
        "s3_key": key,
        "status": "uploaded",
    }

    # Try to determine object size
    try:
        head = _s3.head_object(Bucket=S3_INPUT_BUCKET, Key=key)
        size = head.get("ContentLength", None)
        logger.debug("Uploaded object size: %s bytes", size)
    except ClientError:
        size = None

    # If size available and small enough, attempt realtime transcription in background
    if size is not None and size <= MAX_REALTIME_BYTES and transcribe_module and getattr(transcribe_module, "whisper_module", None) is not None:
        def _bg_realtime(bucket, key, run_id):
            try:
                res = transcribe_module.transcribe_s3_uri(f"s3://{bucket}/{key}")
                logger.info("Realtime transcription finished for %s: %s", key, res)
                # optionally persist / notify elsewhere
            except Exception:
                logger.exception("Background realtime transcription failed for %s", key)

        background.add_task(_bg_realtime, S3_INPUT_BUCKET, key, run_id)
        result["status"] = "processing_realtime"
        result["note"] = "Realtime transcription started in background"
        return result

    # If client requested workflow start and we have Step Functions configured, attempt to start
    if start_workflow and sf_handlers and STATE_MACHINE_ARN:
        try:
            exec_resp = sf_handlers.start_state_machine_execution({"audio_s3_uri": s3_uri, "run_id": run_id})
            result["status"] = "workflow_started"
            result["execution"] = exec_resp
            return result
        except Exception:
            logger.exception("Failed starting state machine; returning upload info")

    # Otherwise return upload info
    return result


@app.post("/upload")
async def upload_audio(
    file: UploadFile = File(...),
    background_tasks: BackgroundTasks = None,
    start_workflow: bool = Query(False, alias="start_workflow"),
):
    """
    Accept a multipart file upload. Returns JSON including at least 's3_uri' and 'upload_id'.
    Query param start_workflow=true will attempt to start a Step Functions execution if configured.
    """
    background_tasks = background_tasks or BackgroundTasks()
    if not file:
        raise HTTPException(status_code=400, detail="Missing file")

    content_type = (file.content_type or "").lower()
    if not (content_type.startswith("audio") or content_type.startswith("application/octet-stream")):
        logger.debug("Upload content_type=%s; backend may still accept it", content_type)

    try:
        result = await _save_upload_and_maybe_transcribe(file, start_workflow, background_tasks)
        return JSONResponse(status_code=202, content=result)
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Upload handling failed: %s", e)
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/start-workflow")
def start_workflow(body: dict = Body(...)):
    """
    Start Step Functions workflow given a JSON body like {"s3_uri": "..."} or {"audio_s3_uri": "..."}.
    Returns the execution ARN and startDate.
    """
    if not STATE_MACHINE_ARN:
        raise HTTPException(status_code=400, detail="STATE_MACHINE_ARN not configured")
    if not sf_handlers:
        raise HTTPException(status_code=500, detail="Orchestration handlers not available")

    # Prefer audio_s3_uri or s3_uri
    s3_uri = body.get("audio_s3_uri") or body.get("s3_uri") or body.get("s3_input")
    if not s3_uri:
        raise HTTPException(status_code=400, detail="Missing s3_uri in request body")

    try:
        resp = sf_handlers.start_state_machine_execution({"audio_s3_uri": s3_uri, "metadata": body.get("metadata", {})})
        return JSONResponse(status_code=202, content={"status": "started", "execution": resp})
    except Exception as e:
        logger.exception("Failed to start workflow: %s", e)
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/presign")
def presign_put(filename: str, content_type: Optional[str] = None, expires_in: int = 900):
    """
    Provide a presigned PUT URL clients can use to upload directly to S3.
    Returns JSON with 'url', 's3_uri', and 'upload_id'.
    """
    if not S3_INPUT_BUCKET:
        raise HTTPException(status_code=500, detail="Server not configured with TRANSFORM_INPUT_BUCKET")
    run_id = uuid.uuid4().hex
    key = _s3_key_for_upload(filename, prefix=S3_INPUT_PREFIX, run_id=run_id)
    try:
        params = {"Bucket": S3_INPUT_BUCKET, "Key": key}
        if content_type:
            params["ContentType"] = content_type
        url = _s3.generate_presigned_url(ClientMethod="put_object", Params=params, ExpiresIn=int(expires_in))
    except ClientError as e:
        logger.exception("Failed generating presigned url: %s", e)
        raise HTTPException(status_code=500, detail=str(e))

    return {"url": url, "s3_uri": f"s3://{S3_INPUT_BUCKET}/{key}", "upload_id": run_id}


@app.get("/health")
def health():
    return {"status": "ok", "s3_input_bucket_configured": bool(S3_INPUT_BUCKET)}


@app.get("/status/{upload_id}")
def status(upload_id: str):
    """
    Return a result if final result.json exists in OUTPUT_S3_BUCKET under prefix/run_id/result.json.
    """
    if not OUTPUT_S3_BUCKET:
        raise HTTPException(status_code=404, detail="No OUTPUT_S3_BUCKET configured")
    prefix = OUTPUT_S3_PREFIX.rstrip("/")
    key = f"{prefix}/{upload_id}/result.json"
    try:
        resp = _s3.get_object(Bucket=OUTPUT_S3_BUCKET, Key=key)
        body = resp["Body"].read()
        try:
            obj = json.loads(body.decode("utf-8"))
            return {"found": True, "result": obj}
        except Exception:
            return {"found": True, "result_raw": body.decode("utf-8", errors="replace")}
    except ClientError as e:
        code = e.response.get("Error", {}).get("Code", "")
        if code in ("NoSuchKey", "NoSuchBucket", "404"):
            return {"found": False}
        logger.exception("S3 error while fetching status: %s", e)
        raise HTTPException(status_code=500, detail=str(e))
