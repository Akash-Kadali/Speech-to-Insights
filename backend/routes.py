"""
FastAPI routes for the speech_to_insights project.

Upgrades / features:
- POST /upload : accept multipart audio upload, store to S3 input bucket (or delegate to handlers),
  optionally kick off realtime transcription or start Step Functions.
- POST /start-workflow : start an orchestration run (Step Functions) given an s3_uri.
- GET  /health : lightweight health check.
- GET  /presign : create a presigned S3 PUT URL for client uploads (supports content_type and expires_in).
- GET  /status/{upload_id} : check for final result.json in OUTPUT_S3_BUCKET.
- GET  /sessions : list processed sessions (reads OUTPUT_S3_BUCKET when available).
- GET  /admin/queue : list recent input uploads / processing queue (reads S3_INPUT_BUCKET when available).
- Defensive error handling, size checks, and optional immediate workflow start.
"""
from __future__ import annotations

import io
import os
import uuid
import json
import time
import logging
from typing import Optional, List, Dict

from fastapi import FastAPI, File, UploadFile, HTTPException, BackgroundTasks, Query, Body
from fastapi.responses import JSONResponse

# boto3 import defensively (some test environments may not have it)
try:
    import boto3  # type: ignore
    from botocore.exceptions import ClientError  # type: ignore
    _BOTO3_AVAILABLE = True
except Exception:
    boto3 = None  # type: ignore
    ClientError = Exception
    _BOTO3_AVAILABLE = False

# local pipeline helpers (best-effort)
try:
    from . import handlers  # central upload / s3 / workflow helpers
except Exception:
    handlers = None  # type: ignore

try:
    from . import step_fn_handlers as sf_handlers  # optional lower-level stepfn helper
except Exception:
    sf_handlers = None  # type: ignore

logger = logging.getLogger("routes")
_log_level_name = os.getenv("LOG_LEVEL", "INFO").upper()
logger.setLevel(getattr(logging, _log_level_name, logging.INFO))
if not logger.handlers:
    ch = logging.StreamHandler()
    ch.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
    logger.addHandler(ch)

app = FastAPI(title="speech_to_insights API")

# CORS configuration via ALLOW_ORIGINS (comma-separated) or default to "*"
_allow_origins = os.getenv("ALLOW_ORIGINS", "*")
if _allow_origins.strip() == "" or _allow_origins.strip() == "*":
    allow_origins = ["*"]
else:
    allow_origins = [o.strip() for o in _allow_origins.split(",") if o.strip()]

from fastapi.middleware.cors import CORSMiddleware

app.add_middleware(
    CORSMiddleware,
    allow_origins=allow_origins,
    allow_methods=["*"],
    allow_headers=["*"],
    allow_credentials=True,
)

# Config
S3_INPUT_BUCKET = (
    os.getenv("TRANSFORM_INPUT_BUCKET")
    or os.getenv("INPUT_S3_BUCKET")
    or os.getenv("TRANSFORM_INPUT_BUCKET_NAME")
)
S3_INPUT_PREFIX = os.getenv("TRANSFORM_INPUT_PREFIX", "inputs").strip("/")
STATE_MACHINE_ARN = os.getenv("STATE_MACHINE_ARN")
OUTPUT_S3_BUCKET = os.getenv("OUTPUT_S3_BUCKET")
OUTPUT_S3_PREFIX = os.getenv("OUTPUT_S3_PREFIX", "outputs").strip("/")
_MAX_REALTIME_BYTES = os.getenv("MAX_REALTIME_BYTES", "5242880")
try:
    MAX_REALTIME_BYTES = int(_MAX_REALTIME_BYTES)
except Exception:
    MAX_REALTIME_BYTES = 5 * 1024 * 1024

if not S3_INPUT_BUCKET:
    logger.warning("No TRANSFORM_INPUT_BUCKET configured. /upload and /presign will fail unless bucket provided.")

# Lazy boto3 S3 client
_s3_client = None


def _get_s3_client():
    global _s3_client
    if _s3_client is None:
        if not _BOTO3_AVAILABLE:
            raise RuntimeError("boto3 is not available in this environment")
        region = os.getenv("AWS_REGION") or os.getenv("AWS_DEFAULT_REGION")
        _s3_client = boto3.client("s3", region_name=region) if region else boto3.client("s3")
    return _s3_client


def _s3_key_for_upload(filename: str, prefix: Optional[str] = None, run_id: Optional[str] = None) -> str:
    run_id = run_id or uuid.uuid4().hex
    prefix_final = (prefix or S3_INPUT_PREFIX or "inputs").rstrip("/")
    safe_name = filename.replace(" ", "_")
    return f"{prefix_final}/{run_id}/{safe_name}"


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

    if file is None:
        raise HTTPException(status_code=400, detail="Missing file")

    content_type = file.content_type or None
    filename = file.filename or f"upload-{int(time.time())}.bin"

    # Read payload once into memory (ok for demo / small files). Replace with stream-to-tempfile if needed.
    try:
        body = await file.read()
    except Exception as e:
        logger.exception("Failed to read upload file: %s", e)
        raise HTTPException(status_code=400, detail="Unable to read uploaded file")

    if not body:
        raise HTTPException(status_code=400, detail="Empty file uploaded")

    # If handlers exist, let them handle presign/upload/workflow
    if handlers and getattr(handlers, "handle_upload_fileobj", None):
        try:
            bio = io.BytesIO(body)
            kwargs = {
                "fileobj": bio,
                "filename": filename,
                "start_workflow": bool(start_workflow),
                "presign": False,
                "content_type": content_type,
            }
            # Some handlers use a positional signature; be defensive
            try:
                res = handlers.handle_upload_fileobj(**kwargs)
            except TypeError:
                res = handlers.handle_upload_fileobj(bio, filename, bool(start_workflow), False, content_type)
            status_code = 202 if res.get("ok", True) else 500
            return JSONResponse(status_code=status_code, content=res)
        except HTTPException:
            raise
        except Exception as exc:
            logger.exception("Upload failed in handlers: %s", exc)
            raise HTTPException(status_code=500, detail=str(exc))

    # Fallback: upload directly to S3
    if not S3_INPUT_BUCKET:
        raise HTTPException(status_code=500, detail="Server misconfigured: no TRANSFORM_INPUT_BUCKET")

    run_id = uuid.uuid4().hex
    key = _s3_key_for_upload(filename, prefix=S3_INPUT_PREFIX, run_id=run_id)
    try:
        s3 = _get_s3_client()
        bio = io.BytesIO(body)
        extra_args = {"ContentType": content_type} if content_type else {}
        # boto3 upload_fileobj signature: upload_fileobj(Fileobj, Bucket, Key, ExtraArgs=...)
        if extra_args:
            s3.upload_fileobj(Fileobj=bio, Bucket=S3_INPUT_BUCKET, Key=key, ExtraArgs=extra_args)
        else:
            s3.upload_fileobj(Fileobj=bio, Bucket=S3_INPUT_BUCKET, Key=key)
        s3_uri = f"s3://{S3_INPUT_BUCKET}/{key}"
        result = {
            "ok": True,
            "upload_id": run_id,
            "s3_uri": s3_uri,
            "s3_bucket": S3_INPUT_BUCKET,
            "s3_key": key,
            "status": "uploaded",
            "size_bytes": len(body),
        }
    except ClientError as e:
        logger.exception("S3 upload failed: %s", e)
        raise HTTPException(status_code=500, detail="S3 upload failed")
    except Exception as exc:
        logger.exception("Unexpected upload error: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc))

    # If configured, start workflow (best-effort) in background
    if start_workflow and getattr(handlers, "start_workflow_for_s3_uri", None):
        try:
            # handlers.start_workflow_for_s3_uri may be sync; run in background to avoid blocking request
            background_tasks.add_task(handlers.start_workflow_for_s3_uri, s3_uri, run_id)
            result["status"] = "workflow_started_background"
        except Exception:
            logger.exception("Failed scheduling workflow start; returning upload info")
            result["note"] = "workflow_start_schedule_failed"

    return JSONResponse(status_code=202, content=result)


@app.get("/presign")
def presign_put(filename: str, content_type: Optional[str] = None, expires_in: int = 900):
    """
    Provide a presigned PUT URL clients can use to upload directly to S3.
    Returns JSON with 'url', 's3_uri', and 'upload_id'.
    """
    # Prefer handler-provided presign helper if present
    if handlers:
        # try a few common helper names defensively
        for helper_name in ("generate_presigned_put", "_generate_presigned_put", "generate_presign_put"):
            helper = getattr(handlers, helper_name, None)
            if callable(helper):
                try:
                    # many handler helpers expect (bucket, key, expires_in, content_type) or (filename,...)
                    try:
                        presign = helper(filename=filename, content_type=content_type, expires_in=expires_in)
                    except TypeError:
                        # try alternate signature: (filename, content_type, expires_in)
                        presign = helper(filename, content_type, expires_in)
                    return JSONResponse(status_code=200, content={"ok": True, "result": presign})
                except Exception:
                    logger.exception("handlers.%s failed; falling back to boto3", helper_name)
                    break

    # Fallback: generate presigned URL directly using boto3
    if not S3_INPUT_BUCKET:
        raise HTTPException(status_code=500, detail="Server not configured with TRANSFORM_INPUT_BUCKET")

    run_id = uuid.uuid4().hex
    key = _s3_key_for_upload(filename, prefix=S3_INPUT_PREFIX, run_id=run_id)
    try:
        s3 = _get_s3_client()
        params = {"Bucket": S3_INPUT_BUCKET, "Key": key}
        if content_type:
            params["ContentType"] = content_type
        url = s3.generate_presigned_url(ClientMethod="put_object", Params=params, ExpiresIn=int(expires_in))
        return JSONResponse(status_code=200, content={"ok": True, "url": url, "s3_uri": f"s3://{S3_INPUT_BUCKET}/{key}", "upload_id": run_id})
    except ClientError:
        logger.exception("Failed generating presigned url")
        raise HTTPException(status_code=500, detail="Failed generating presigned URL")
    except Exception:
        logger.exception("Failed generating presigned url")
        raise HTTPException(status_code=500, detail="Failed generating presigned URL")


@app.post("/start-workflow")
def start_workflow(body: dict = Body(...)):
    """
    Start Step Functions workflow given a JSON body like {"s3_uri": "..."} or {"audio_s3_uri": "..."}.
    Returns the execution ARN and startDate (or handler response).
    """
    if not STATE_MACHINE_ARN:
        raise HTTPException(status_code=400, detail="STATE_MACHINE_ARN not configured")
    if not handlers or not getattr(handlers, "start_workflow_for_s3_uri", None):
        raise HTTPException(status_code=500, detail="Orchestration handlers not available")

    s3_uri = body.get("audio_s3_uri") or body.get("s3_uri") or body.get("s3_input")
    if not s3_uri:
        raise HTTPException(status_code=400, detail="Missing s3_uri in request body")

    try:
        resp = handlers.start_workflow_for_s3_uri(s3_uri, run_id=body.get("run_id"))
        if not resp.get("ok", True):
            raise RuntimeError(resp.get("error", "workflow_start_failed"))
        return JSONResponse(status_code=202, content={"status": "started", "execution": resp.get("execution", resp)})
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Failed to start workflow: %s", e)
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/status/{upload_id}")
def status(upload_id: str):
    """
    Return a result if final result.json exists in OUTPUT_S3_BUCKET under prefix/{upload_id}/result.json.
    """
    if handlers and getattr(handlers, "fetch_result_if_exists", None):
        try:
            res = handlers.fetch_result_if_exists(upload_id)
            return JSONResponse(status_code=200, content=res)
        except HTTPException:
            raise
        except Exception as exc:
            logger.exception("fetch_result_if_exists failed: %s", exc)
            raise HTTPException(status_code=500, detail=str(exc))

    if not OUTPUT_S3_BUCKET:
        raise HTTPException(status_code=404, detail="No OUTPUT_S3_BUCKET configured")

    key = f"{OUTPUT_S3_PREFIX.rstrip('/')}/{upload_id}/result.json"
    try:
        s3 = _get_s3_client()
        resp = s3.get_object(Bucket=OUTPUT_S3_BUCKET, Key=key)
        body = resp["Body"].read()
        try:
            obj = json.loads(body.decode("utf-8"))
            return JSONResponse(status_code=200, content={"found": True, "result": obj})
        except Exception:
            return JSONResponse(status_code=200, content={"found": True, "result_raw": body.decode("utf-8", errors="replace")})
    except ClientError as e:
        code = ""
        try:
            code = e.response.get("Error", {}).get("Code", "")
        except Exception:
            pass
        if code in ("NoSuchKey", "NoSuchBucket", "404"):
            return JSONResponse(status_code=200, content={"found": False})
        logger.exception("S3 error while fetching status: %s", e)
        raise HTTPException(status_code=500, detail="Failed fetching status")
    except Exception as exc:
        logger.exception("Unexpected error fetching status: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc))


@app.get("/health")
def health():
    """
    Lightweight health probe.
    """
    out = {"status": "ok"}
    # S3 input bucket check
    try:
        if S3_INPUT_BUCKET and _BOTO3_AVAILABLE:
            s3 = _get_s3_client()
            s3.list_objects_v2(Bucket=S3_INPUT_BUCKET, MaxKeys=1)
            out["s3_input_bucket_ok"] = True
        else:
            out["s3_input_bucket_ok"] = bool(S3_INPUT_BUCKET)
    except Exception:
        logger.exception("S3 input bucket check failed")
        out["s3_input_bucket_ok"] = False

    # OUTPUT bucket check
    try:
        if OUTPUT_S3_BUCKET and _BOTO3_AVAILABLE:
            s3 = _get_s3_client()
            s3.list_objects_v2(Bucket=OUTPUT_S3_BUCKET, MaxKeys=1)
            out["output_s3_bucket_ok"] = True
        else:
            out["output_s3_bucket_ok"] = bool(OUTPUT_S3_BUCKET)
    except Exception:
        logger.exception("S3 output bucket check failed")
        out["output_s3_bucket_ok"] = False

    out["step_functions_configured"] = bool(STATE_MACHINE_ARN)
    out["handlers_available"] = handlers is not None
    return JSONResponse(status_code=200, content=out)


# -----------------------
# New: Sessions and Admin Queue endpoints
# -----------------------

def _list_s3_objects(bucket: str, prefix: str = "", max_keys: int = 50) -> List[Dict]:
    """Helper to list objects; defensive around boto3 availability."""
    if not _BOTO3_AVAILABLE:
        logger.debug("_list_s3_objects: boto3 not available")
        return []
    try:
        s3 = _get_s3_client()
        resp = s3.list_objects_v2(Bucket=bucket, Prefix=prefix, MaxKeys=max_keys)
        return resp.get("Contents", []) or []
    except Exception as exc:
        logger.exception("_list_s3_objects failed: %s", exc)
        return []


@app.get("/sessions")
def sessions(limit: int = Query(50, ge=1, le=500)):
    """
    Return a JSON list of recent processed sessions.
    If OUTPUT_S3_BUCKET is configured, list objects under OUTPUT_S3_PREFIX and
    return lightweight metadata for each session (key, last_modified, size, preview).
    Otherwise return a minimal empty shape.
    """
    if OUTPUT_S3_BUCKET and _BOTO3_AVAILABLE:
        prefix = OUTPUT_S3_PREFIX.rstrip("/") + "/" if OUTPUT_S3_PREFIX else ""
        objs = _list_s3_objects(OUTPUT_S3_BUCKET, prefix=prefix, max_keys=limit)
        sessions_list = []
        for o in objs:
            key = o.get("Key")
            if not key:
                continue
            # attempt to include a parsed summary if a result.json exists next to the key,
            # otherwise include metadata only.
            session_id = key.split("/")[-2] if "/" in key else key
            sessions_list.append({
                "id": session_id,
                "key": key,
                "last_modified": o.get("LastModified").isoformat() if o.get("LastModified") else None,
                "size": o.get("Size"),
            })
        return JSONResponse(status_code=200, content={"ok": True, "sessions": sessions_list})
    # If handlers know how to produce a listing, prefer them
    if handlers and getattr(handlers, "list_sessions", None):
        try:
            res = handlers.list_sessions(limit=limit)
            return JSONResponse(status_code=200, content={"ok": True, "sessions": res})
        except Exception:
            logger.exception("handlers.list_sessions failed; falling back to empty list")
    # fallback: empty
    return JSONResponse(status_code=200, content={"ok": True, "sessions": []})


@app.get("/admin/queue")
def admin_queue(limit: int = Query(50, ge=1, le=500)):
    """
    Return a JSON representation of the current processing queue / recent uploads.

    Strategy:
    - If handlers provide queue introspection, use it.
    - Else, list recent objects in S3_INPUT_BUCKET/INPUT_PREFIX and return minimal metadata.
    """
    # prefer handler-provided queue introspection
    if handlers and getattr(handlers, "list_queue", None):
        try:
            q = handlers.list_queue(limit=limit)
            return JSONResponse(status_code=200, content={"ok": True, "queue": q})
        except Exception:
            logger.exception("handlers.list_queue failed; falling back to S3 listing")

    # fallback: list S3 input objects
    if S3_INPUT_BUCKET and _BOTO3_AVAILABLE:
        prefix = S3_INPUT_PREFIX.rstrip("/") + "/" if S3_INPUT_PREFIX else ""
        objs = _list_s3_objects(S3_INPUT_BUCKET, prefix=prefix, max_keys=limit)
        queue = []
        for o in objs:
            key = o.get("Key")
            if not key:
                continue
            # extract run_id as the first path segment after prefix (inputs/{run_id}/file.wav)
            parts = key[len(prefix):].split("/") if key.startswith(prefix) else key.split("/")
            run_id = parts[0] if parts else key
            queue.append({
                "id": run_id,
                "key": key,
                "last_modified": o.get("LastModified").isoformat() if o.get("LastModified") else None,
                "size": o.get("Size"),
                # processing status can't be inferred reliably from S3; frontend should poll /status/{id}
                "status": "uploaded"
            })
        return JSONResponse(status_code=200, content={"ok": True, "queue": queue})

    # final fallback: empty queue
    return JSONResponse(status_code=200, content={"ok": True, "queue": []})
