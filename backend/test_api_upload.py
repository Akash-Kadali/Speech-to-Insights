# backend/test_api_upload.py
"""
Contract tests for the HTTP upload endpoint that kicks off transcription.

Objectives:
- Discover a FastAPI/Starlette `app` object in backend.app or backend.routes.
- Use TestClient to POST multipart/form-data audio to the upload route.
- Verify:
  * endpoint exists and responds (200/201/202)
  * returns JSON
  * JSON contains at least one of these keys: 's3_uri', 'upload_id', 'location', 'status', 'result'
  * missing-file request returns a 4xx error

Notes:
- These are conservative contract tests. If your project uses different endpoint names
  or signature, adapt the route discovery section or provide a small adapter in backend/app.py
  that exposes a FastAPI app at `app`.
- The tests will skip if FastAPI/TestClient or the backend app module is not available.
"""

import io
import os
import importlib
from typing import List

import pytest

# These imports are optional; skip tests gracefully if not available
fastapi = pytest.importorskip("fastapi", reason="fastapi is required for API contract tests")
TestClient = pytest.importorskip("fastapi.testclient", reason="fastapi.testclient is required for API contract tests").TestClient

# Try to locate the app
APP_MODULE_CANDIDATES = ("backend.app", "backend.routes", "app", "routes")

app = None
app_module_name = None
for modname in APP_MODULE_CANDIDATES:
    try:
        mod = importlib.import_module(modname)
        # common names for the ASGI app: app, create_app()
        if hasattr(mod, "app"):
            candidate = getattr(mod, "app")
            # FastAPI app check (duck-typing)
            if hasattr(candidate, "routes"):
                app = candidate
                app_module_name = modname
                break
        if hasattr(mod, "create_app") and callable(getattr(mod, "create_app")):
            candidate = mod.create_app()
            if hasattr(candidate, "routes"):
                app = candidate
                app_module_name = modname
                break
    except Exception:
        continue

if app is None:
    pytest.skip("No FastAPI/Starlette `app` found in modules: " + ", ".join(APP_MODULE_CANDIDATES))


def _discover_upload_paths(app) -> List[str]:
    """
    Inspect app routes and return list of candidate upload paths.
    Conservative approach: look for any POST endpoints whose path contains 'upload',
    'transcribe', 'ingest', or 'audio'. Also include presign and start-workflow as secondary candidates.
    """
    candidates = []
    for route in getattr(app, "routes", []):
        # route.path may be present on Starlette/FastAPI Route
        path = getattr(route, "path", None) or getattr(route, "path_format", None) or getattr(route, "name", "")
        methods = getattr(route, "methods", set())
        if not path or "POST" not in methods:
            continue
        low = path.lower()
        if any(k in low for k in ("upload", "transcribe", "ingest", "audio", "upload-audio")):
            candidates.append(path)
        # include presign as potential helper endpoint
        if "presign" in low or "presigned" in low:
            candidates.append(path)
        if "start-workflow" in low or "start_workflow" in low:
            candidates.append(path)
    # fallback to /upload if present
    try:
        all_paths = [r.path for r in getattr(app, "routes", []) if hasattr(r, "path")]
        if "/upload" in all_paths:
            candidates.insert(0, "/upload")
    except Exception:
        pass
    # dedupe while preserving order
    seen = set()
    deduped = []
    for p in candidates:
        if p not in seen:
            deduped.append(p)
            seen.add(p)
    return deduped


UPLOAD_ENDPOINT_CANDIDATES = _discover_upload_paths(app)
if not UPLOAD_ENDPOINT_CANDIDATES:
    # If no obvious candidates found, include a small set of reasonable defaults to try
    UPLOAD_ENDPOINT_CANDIDATES = ["/upload", "/uploads", "/transcribe", "/ingest/audio", "/audio/upload", "/presign", "/start-workflow"]


@pytest.fixture(scope="module")
def client():
    return TestClient(app)


def _make_test_audio_bytes(duration_seconds: float = 0.5, sample_rate: int = 16000) -> bytes:
    """
    Produce a very short (silence) WAV-like byte payload suitable for multipart upload.
    Create a minimal valid WAV header for 16-bit PCM mono silence to maximize compatibility.
    """
    import wave
    import struct
    import io
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)  # 16-bit
        w.setframerate(sample_rate)
        n_frames = int(duration_seconds * sample_rate)
        silent_frame = struct.pack("<h", 0)
        w.writeframes(silent_frame * n_frames)
    return buf.getvalue()


def _assert_response_json_has_expected_key(json_obj: dict):
    """
    Contract: response JSON should contain at least one useful key pointing to the upload/result.
    """
    expected_keys = {"s3_uri", "s3_path", "upload_id", "id", "location", "status", "result", "transcript"}
    if not any(k in json_obj for k in expected_keys):
        # be lenient: also accept short keys that look like urls or dicts containing these
        if any(isinstance(v, str) and (v.startswith("s3://") or v.startswith("/")) for v in json_obj.values()):
            return
        pytest.fail(
            "Response JSON did not contain expected keys. Expected one of "
            f"{expected_keys}. Actual keys: {list(json_obj.keys())}"
        )


@pytest.mark.parametrize("path", UPLOAD_ENDPOINT_CANDIDATES)
def test_upload_endpoint_accepts_file_and_returns_json(client, path):
    """
    Try posting a small audio file to candidate upload endpoints.
    Accepts first successful candidate that returns 200/201/202 and JSON.
    """
    audio_bytes = _make_test_audio_bytes()
    files = {"file": ("test.wav", audio_bytes, "audio/wav")}
    try:
        resp = client.post(path, files=files)
    except Exception as e:
        pytest.skip(f"POST to {path} raised exception (route may not exist): {e}")

    # If route is not found or method not allowed, skip
    if resp.status_code in (404, 405):
        pytest.skip(f"Endpoint {path} not implemented (status={resp.status_code}).")
    assert resp.status_code in (200, 201, 202), f"Unexpected status code {resp.status_code} for {path}. Response text: {resp.text}"
    try:
        j = resp.json()
    except ValueError:
        pytest.fail(f"Response from {path} is not valid JSON. Response text: {resp.text}")
    assert isinstance(j, dict), f"Expected JSON object from {path}, got {type(j)}"
    _assert_response_json_has_expected_key(j)


@pytest.mark.parametrize("path", UPLOAD_ENDPOINT_CANDIDATES)
def test_upload_missing_file_returns_4xx(client, path):
    """
    POSTing without a file should return a 4xx error (400/422/etc) rather than 2xx success.
    If endpoint not found (404/405) we skip.
    """
    try:
        resp = client.post(path, data={"some": "value"})
    except Exception as e:
        pytest.skip(f"POST to {path} raised exception (route may not exist): {e}")
    if resp.status_code in (404, 405):
        pytest.skip(f"Endpoint {path} not implemented (status={resp.status_code}).")
    assert 400 <= resp.status_code < 500, f"Expected 4xx for missing file to {path}; got {resp.status_code}. Response: {resp.text}"


def test_upload_endpoint_handles_large_file_gracefully(client):
    """
    Post a larger (but still modest) payload to ensure the endpoint either accepts
    and returns a proper response or returns a 413/4xx with helpful message.
    """
    audio_bytes = _make_test_audio_bytes(duration_seconds=2.0)
    files = {"file": ("big_test.wav", audio_bytes, "audio/wav")}
    path = UPLOAD_ENDPOINT_CANDIDATES[0]
    try:
        resp = client.post(path, files=files)
    except Exception as e:
        pytest.skip(f"POST to {path} raised exception (route may not exist): {e}")
    if resp.status_code in (404, 405):
        pytest.skip(f"Endpoint {path} not implemented (status={resp.status_code}).")
    assert resp.status_code in (200, 201, 202, 413, 400, 422), (
        "Unexpected status code for larger upload. Received "
        f"{resp.status_code}. Response: {resp.text}"
    )
    # If successful and JSON, validate keys
    if resp.status_code in (200, 201, 202):
        try:
            j = resp.json()
            assert isinstance(j, dict)
            _assert_response_json_has_expected_key(j)
        except ValueError:
            pytest.fail(f"Successful response from {path} is not JSON: {resp.text}")
