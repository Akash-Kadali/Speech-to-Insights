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

from fastapi import FastAPI

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
log_level = os.getenv("LOG_LEVEL", "INFO")
logger.setLevel(log_level)


def create_app(title: Optional[str] = None, description: Optional[str] = None) -> FastAPI:
    """
    Factory to construct the FastAPI app. Useful in tests to create isolated apps.
    """
    app_title = title or os.getenv("APP_TITLE", "speech_to_insights API")
    app_description = description or os.getenv("APP_DESCRIPTION", "API for speech_to_insights backend")

    app = FastAPI(title=app_title, description=app_description)

    # Import and mount routes (kept minimal here; routes.py handles route definitions)
    try:
        # routes defines `app` itself, but importing routes ensures route registration.
        # If routes exposes separate router objects in future, adjust accordingly.
        from . import routes  # type: ignore
    except Exception as exc:
        logger.exception("Failed to import backend.routes: %s", exc)
        raise RuntimeError(f"Failed to import backend.routes: {exc}") from exc

    # If routes defines a FastAPI app object, prefer including its router contents.
    # This avoids duplicating app definitions while allowing direct import of backend.app.app.
    try:
        # If routes has `router` or exports endpoints via app attribute, include them.
        if hasattr(routes, "app") and getattr(routes, "app") is not app:
            # mount routes.app via include_router to keep a single app instance
            try:
                for r in getattr(routes.app, "routes", []):
                    # FastAPI/Starlette doesn't provide a direct API to copy routes, so include the router if available
                    pass
            except Exception:
                # Fallback: include routes.router if present
                if hasattr(routes, "router"):
                    app.include_router(getattr(routes, "router"))
        # If routes exposes a router object, include it
        if hasattr(routes, "router"):
            app.include_router(getattr(routes, "router"))
    except Exception:
        # If including router fails, ignore—routes module should have already registered endpoints
        logger.debug("Including routes' router failed or not necessary; routes module import suffices")

    # Basic startup / shutdown events for logging and optional initialization
    @app.on_event("startup")
    async def _startup():
        logger.info("Starting speech_to_insights app (env=%s)", os.getenv("ENV", "local"))

    @app.on_event("shutdown")
    async def _shutdown():
        logger.info("Shutting down speech_to_insights app")

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
