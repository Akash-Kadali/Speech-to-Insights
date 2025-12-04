#
# Main entrypoint for the speech_to_insights backend.
#
# - Exposes a FastAPI `app` object and a `create_app` factory.
# - Loads optional .env in local development (non-destructive).
# - Mounts frontend static files (if present) under /static and serves index.html at /.
# - Provides a few local-only debug endpoints for convenience.
#
from __future__ import annotations

import os
import logging
from typing import Optional
from contextlib import asynccontextmanager
from datetime import datetime

from fastapi import FastAPI, Request, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse

# Attempt to load .env for local development (optional dependency).
if os.getenv("ENV_LOADED") is None:
    try:
        from dotenv import load_dotenv  # type: ignore

        base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        env_path = os.path.join(base_dir, ".env")
        if os.path.exists(env_path):
            load_dotenv(env_path)
            os.environ["ENV_LOADED"] = "1"
    except Exception:
        # don't fail if python-dotenv isn't installed
        pass

# Basic logger configuration (safe for imports/tests)
logger = logging.getLogger("backend.app")
if not logger.handlers:
    # Add a simple stream handler so logs are visible in dev/test by default
    handler = logging.StreamHandler()
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s"))
    logger.addHandler(handler)

_log_level_name = os.getenv("LOG_LEVEL", "INFO").upper()
_log_level = getattr(logging, _log_level_name, logging.INFO)
logger.setLevel(_log_level)


def _mask_secret(val: Optional[str]) -> Optional[str]:
    """Return a safely masked representation of a secret for debug endpoints."""
    if not val:
        return None
    s = str(val)
    if len(s) <= 8:
        return "*" * len(s)
    return "*" * (len(s) - 4) + s[-4:]


def create_app(title: Optional[str] = None, description: Optional[str] = None) -> FastAPI:
    """
    Construct and return a FastAPI app instance.

    Use this factory in tests to create isolated applications.
    """
    app_title = title or os.getenv("APP_TITLE", "speech_to_insights API")
    app_description = description or os.getenv("APP_DESCRIPTION", "API for speech_to_insights backend")

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        logger.info("Starting speech_to_insights app (ENV=%s)", os.getenv("ENV", "local"))
        try:
            yield
        finally:
            logger.info("Shutting down speech_to_insights app")

    app = FastAPI(title=app_title, description=app_description, lifespan=lifespan)

    # CORS configuration: ALLOW_ORIGINS can be "*" or comma-separated origins
    allow_origins_raw = os.getenv("ALLOW_ORIGINS", "*")
    if allow_origins_raw.strip() == "*" or allow_origins_raw.strip() == "":
        allow_origins = ["*"]
    else:
        allow_origins = [o.strip() for o in allow_origins_raw.split(",") if o.strip()]

    app.add_middleware(
        CORSMiddleware,
        allow_origins=allow_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    # Import routes module early and include its router(s) BEFORE mounting static files.
    # This ensures API endpoints take priority over a SPA static-file fallback.
    routes = None
    try:
        # Importing routes may register endpoints on its own module-level app/router.
        from . import routes as _routes  # type: ignore
        routes = _routes
        logger.debug("Imported backend.routes successfully")
    except Exception as exc:
        logger.exception("Failed to import backend.routes at startup: %s", exc)
        # fail-fast so developers see startup error rather than subtle silent issues
        raise RuntimeError(f"Failed to import backend.routes: {exc}") from exc

    # If routes exposes a router or an app, include it on our FastAPI instance.
    try:
        if hasattr(routes, "router"):
            app.include_router(getattr(routes, "router"))
            logger.debug("Included routes.router from backend.routes")
        elif hasattr(routes, "app") and hasattr(getattr(routes, "app"), "router"):
            # Some modules expose their own FastAPI app; include its router to unify.
            app.include_router(getattr(routes, "app").router)
            logger.debug("Included backend.routes.app.router")
        else:
            # If routes registered directly on import (module-level side effects), nothing to include.
            logger.debug("backend.routes did not expose router or app; assuming routes registered on import")
    except Exception as exc:
        logger.exception("Including backend.routes router failed: %s", exc)
        # Continue; routes may have been registered on import already.

    # Attempt to find and mount frontend static files (frontend/ directory sibling to backend/)
    frontend_dir = os.path.join(os.path.dirname(__file__), "..", "frontend")
    frontend_dir = os.path.abspath(frontend_dir)
    if os.path.isdir(frontend_dir):
        try:
            # Mount static files under /static so API routes remain primary
            app.mount("/static", StaticFiles(directory=frontend_dir, html=True), name="frontend_static")
            logger.debug("Mounted frontend static files from %s at /static", frontend_dir)
        except Exception:
            logger.exception("Failed to mount frontend static files; continuing without frontend")

        # Serve index at root for convenience (explicit route). Keep API routes already registered.
        @app.get("/", include_in_schema=False)
        async def _serve_index():
            index_path = os.path.join(frontend_dir, "index.html")
            if os.path.exists(index_path):
                return FileResponse(index_path)
            return JSONResponse({"ok": True, "message": "speech_to_insights backend running"})

    # Local-only debug endpoints (safe defaults). Only enabled when ENV is "local" (default).
    if os.getenv("ENV", "local") == "local":

        @app.get("/debug-env", include_in_schema=False)
        async def _debug_env():
            # Return a curated list of env vars relevant to local debugging. Do not leak raw secrets.
            data = {
                "TRANSFORM_INPUT_BUCKET": os.getenv("TRANSFORM_INPUT_BUCKET"),
                "TRANSFORM_INPUT_PREFIX": os.getenv("TRANSFORM_INPUT_PREFIX"),
                "OUTPUT_S3_BUCKET": os.getenv("OUTPUT_S3_BUCKET"),
                "OUTPUT_S3_PREFIX": os.getenv("OUTPUT_S3_PREFIX"),
                "TRANSFORM_OUTPUT_BUCKET": os.getenv("TRANSFORM_OUTPUT_BUCKET"),
                "AWS_REGION": os.getenv("AWS_REGION"),
                "AWS_ACCESS_KEY_ID": _mask_secret(os.getenv("AWS_ACCESS_KEY_ID")),
                # Mask secret when returning for safety
                "AWS_SECRET_ACCESS_KEY": _mask_secret(os.getenv("AWS_SECRET_ACCESS_KEY")),
                "ALLOW_ORIGINS": os.getenv("ALLOW_ORIGINS"),
                "ENV_LOADED": os.getenv("ENV_LOADED"),
            }
            return JSONResponse(content=data)

        @app.get("/debug-sts", include_in_schema=False)
        async def _debug_sts():
            # Return STS caller identity as seen by boto3 if available.
            try:
                import boto3  # deferred
                client = boto3.client("sts", region_name=os.getenv("AWS_REGION"))
                identity = client.get_caller_identity()
                return JSONResponse(content={
                    "Account": identity.get("Account"),
                    "UserId": identity.get("UserId"),
                    "Arn": identity.get("Arn"),
                })
            except Exception as exc:
                logger.exception("debug-sts failed")
                return JSONResponse(status_code=500, content={"error": str(exc)})

        @app.get("/debug-s3", include_in_schema=False)
        async def _debug_s3():
            # Attempt a small PutObject to configured input bucket to validate permissions.
            try:
                import boto3  # deferred
                s3 = boto3.client("s3", region_name=os.getenv("AWS_REGION"))
                bucket = os.getenv("TRANSFORM_INPUT_BUCKET")
                if not bucket:
                    return JSONResponse(status_code=400, content={"error": "TRANSFORM_INPUT_BUCKET not set"})
                key = f"debug-test-{datetime.utcnow().strftime('%Y%m%dT%H%M%SZ')}.txt"
                s3.put_object(Bucket=bucket, Key=key, Body=b"debug")
                return JSONResponse(content={"status": "ok", "bucket": bucket, "key": key})
            except Exception as exc:
                logger.exception("debug-s3 failed")
                return JSONResponse(status_code=500, content={"error": str(exc)})

    # Catch-all frontend file server (registered after API routes so API keeps priority)
    if os.path.isdir(frontend_dir):

        @app.get("/{full_path:path}", include_in_schema=False)
        async def _serve_frontend_file(full_path: str, request: Request):
            # Normalize and protect against path traversal
            safe_path = os.path.normpath(full_path).lstrip(os.sep)
            candidate = os.path.join(frontend_dir, safe_path)
            frontend_real = os.path.realpath(frontend_dir)
            candidate_real = os.path.realpath(candidate)
            if not candidate_real.startswith(frontend_real):
                raise HTTPException(status_code=404)

            if os.path.exists(candidate_real) and os.path.isfile(candidate_real):
                return FileResponse(candidate_real)

            # Fallback to index.html to support SPA-style routes
            index_path = os.path.join(frontend_dir, "index.html")
            if os.path.exists(index_path):
                return FileResponse(index_path)

            raise HTTPException(status_code=404)

    return app


# Expose a top-level app object for typical ASGI imports (uvicorn, tests, etc.)
app = create_app()

__all__ = ["app", "create_app"]


# Allow running directly for local development: `python -m backend.app`
if __name__ == "__main__":
    import uvicorn

    port = int(os.getenv("PORT", "8000"))
    host = os.getenv("HOST", "0.0.0.0")
    workers = int(os.getenv("UVICORN_WORKERS", "1"))
    log_level = os.getenv("LOG_LEVEL", "info")
    reload_flag = os.getenv("UVICORN_RELOAD", "true").lower() in ("1", "true", "yes")

    # When multiple workers are requested and reload is disabled, run uvicorn in a subprocess
    if workers > 1 and not reload_flag:
        import shlex
        import subprocess

        cmd = (
            f"{shlex.quote('uvicorn')} backend.app:app"
            f" --host {shlex.quote(host)} --port {port}"
            f" --log-level {shlex.quote(log_level)} --workers {workers}"
        )
        if reload_flag:
            cmd += " --reload"
        logger.info("Starting uvicorn (subprocess): %s", cmd)
        subprocess.run(cmd, check=True, shell=True)
    else:
        logger.info("Starting uvicorn (in-process) host=%s port=%d reload=%s", host, port, reload_flag)
        uvicorn.run("backend.app:app", host=host, port=port, reload=reload_flag, log_level=log_level)
