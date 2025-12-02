"""
backend/app.py

Main entrypoint for the speech_to_insights backend.

Purpose:
- Expose a single FastAPI application object named `app` so tests and deployment
  frameworks can import `backend.app:app`.
- Re-export the routes from backend.routes.
- Provide a simple `__main__` block for local development.

Design notes:
- Keeps app creation lightweight but adds a create_app factory to allow tests to
  customize startup behavior.
- Loads .env in local dev if present (non-destructive).
- Adds basic startup/shutdown logging hooks.
"""

from __future__ import annotations

import os
import logging
from typing import Optional
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

# Optionally load environment from a .env in local development to make dev easier.
# This is safe: python-dotenv is optional and we only use it if available.
if os.getenv("ENV_LOADED") is None:
    try:
        from dotenv import load_dotenv  # type: ignore

        env_path = os.path.join(os.path.dirname(__file__), "..", ".env")
        if os.path.exists(env_path):
            load_dotenv(env_path)
            os.environ["ENV_LOADED"] = "1"
    except Exception:
        # ignore if python-dotenv isn't installed
        pass

logger = logging.getLogger("backend.app")
_log_level_name = os.getenv("LOG_LEVEL", "INFO").upper()
_log_level = getattr(logging, _log_level_name, logging.INFO)
logger.setLevel(_log_level)


def create_app(title: Optional[str] = None, description: Optional[str] = None) -> FastAPI:
    """
    Factory to construct the FastAPI app. Useful in tests to create isolated apps.
    """
    app_title = title or os.getenv("APP_TITLE", "speech_to_insights API")
    app_description = description or os.getenv("APP_DESCRIPTION", "API for speech_to_insights backend")

    # lifespan will replace on_event startup/shutdown handlers
    @asynccontextmanager
    async def lifespan(app: FastAPI):
        logger.info("Starting speech_to_insights app (env=%s)", os.getenv("ENV", "local"))
        try:
            yield
        finally:
            logger.info("Shutting down speech_to_insights app")

    app = FastAPI(title=app_title, description=app_description, lifespan=lifespan)

    # Include CORS middleware early so routes can rely on it.
    # Configure origins via ALLOW_ORIGINS env var as comma-separated list; default to allow all in dev.
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

    # Serve frontend static pages at root for local demos if folder exists
    frontend_dir = os.path.join(os.path.dirname(__file__), "..", "frontend", "pages")
    if os.path.isdir(frontend_dir):
        try:
            app.mount("/", StaticFiles(directory=frontend_dir, html=True), name="frontend")
            logger.debug("Mounted frontend static pages from %s", frontend_dir)
        except Exception as exc:
            logger.exception("Failed to mount frontend static files: %s", exc)

    # Import and mount routes (kept minimal here; routes.py handles route definitions)
    try:
        # Importing routes for side-effects (module may register routes on import)
        from . import routes  # type: ignore
    except Exception as exc:
        logger.exception("Failed to import backend.routes: %s", exc)
        raise RuntimeError(f"Failed to import backend.routes: {exc}") from exc

    # If routes exposes a router object, include it explicitly.
    # This covers two patterns:
    #  - routes registers endpoints on import (no further action required)
    #  - routes exposes an APIRouter as `router`, which we include here
    try:
        if hasattr(routes, "router"):
            router = getattr(routes, "router")
            try:
                app.include_router(router)
                logger.debug("Included routes.router from backend.routes")
            except Exception:
                logger.exception("Including routes.router failed; continuing (routes might have been registered on import)")
    except Exception:
        # defensive: if routes import succeeded but router check fails, continue
        logger.debug("Routes import succeeded but router inclusion raised an exception; continuing")

    return app


# Expose a top-level app for frameworks/tests to import
# Prefer using create_app() so this module is import-safe and deterministic.
app = create_app()

__all__ = ["app", "create_app"]


# Allow running directly: `python -m backend.app`
if __name__ == "__main__":
    import uvicorn

    port = int(os.getenv("PORT", "8000"))
    host = os.getenv("HOST", "0.0.0.0")
    workers = int(os.getenv("UVICORN_WORKERS", "1"))
    log_level = os.getenv("LOG_LEVEL", "info")
    # Uvicorn's programmatic interface runs the server in-process; for dev we enable reload when requested.
    reload_flag = os.getenv("UVICORN_RELOAD", "true").lower() in ("1", "true", "yes")
    uvicorn.run("backend.app:app", host=host, port=port, reload=reload_flag, log_level=log_level, workers=workers)
