#!/usr/bin/env bash
set -euo pipefail

# ------------------------------------------------------------
# local_run.sh  (upgraded)
#
# Lightweight developer runner for the speech_to_insights backend.
# - Loads environment from .env (if present)
# - Runs FastAPI with uvicorn (hot-reload by default in dev)
# - Convenience test modes:
#     --test-transcribe <file>   : run transcribe_local_file on a local audio file
#     --test-pii "<text>"        : run redaction/detection on provided text
# - Extra runtime flags: --port, --host, --workers, --no-reload, --log-level
# - Exits non-zero on errors; prints helpful usage.
#
# Examples:
#   ./local_run.sh
#   ./local_run.sh --port 8080 --workers 2
#   ./local_run.sh --test-transcribe /path/to/audio.wav
#   ./local_run.sh --test-pii "Call me at +1-555-123-4567"
# ------------------------------------------------------------

# Default config
PORT=8000
HOST="0.0.0.0"
WORKERS=1
RELOAD="true"
LOG_LEVEL="info"
MODE="server"
TEST_FILE=""
TEST_TEXT=""
PYTHON_BIN="${PYTHON_BIN:-python3}"

usage() {
  cat <<USG
Usage: $0 [options]

Options:
  --port <port>             Server port (default: ${PORT})
  --host <host>             Server host (default: ${HOST})
  --workers <n>             Uvicorn workers (default: ${WORKERS})
  --no-reload               Disable uvicorn --reload (default enabled)
  --log-level <level>       Uvicorn log level (info, debug, warning) (default: ${LOG_LEVEL})
  --test-transcribe <file>  Run local transcription test on file and exit
  --test-pii "<text>"       Run PII detection/redaction test and exit
  -h, --help                Show this help
USG
  exit 1
}

# Load .env if present (export simple KEY=VALUE lines, ignore comments/empty)
if [[ -f ".env" ]]; then
  echo "Loading environment from .env"
  # shellcheck disable=SC2046
  export $(grep -v '^\s*#' .env | sed -n '/=/p' | xargs -I {} bash -c 'echo {}' 2>/dev/null) || true
fi

# parse args
while [[ $# -gt 0 ]]; do
  case "$1" in
    --port) PORT="$2"; shift 2;;
    --host) HOST="$2"; shift 2;;
    --workers) WORKERS="$2"; shift 2;;
    --no-reload) RELOAD="false"; shift 1;;
    --log-level) LOG_LEVEL="$2"; shift 2;;
    --test-transcribe) MODE="transcribe"; TEST_FILE="$2"; shift 2;;
    --test-pii) MODE="pii"; TEST_TEXT="$2"; shift 2;;
    -h|--help) usage ;;
    *) echo "Unknown option: $1"; usage ;;
  esac
done

# basic environment validation
command_exists() {
  command -v "$1" >/dev/null 2>&1
}

if ! command_exists "${PYTHON_BIN}"; then
  echo "ERROR: ${PYTHON_BIN} not found. Activate your virtualenv or install Python 3."
  exit 2
fi

# Check uvicorn availability
if ! "${PYTHON_BIN}" -c "import importlib, sys; sys.exit(0 if importlib.util.find_spec('uvicorn') else 1)"; then
  echo "WARNING: uvicorn not installed in ${PYTHON_BIN} environment. Install via: pip install uvicorn[standard]"
fi

# Mode: server (default)
if [[ "${MODE}" == "server" ]]; then
  echo "Starting FastAPI (uvicorn) at http://${HOST}:${PORT} (workers=${WORKERS}, reload=${RELOAD}, log_level=${LOG_LEVEL})"
  UVICORN_CMD=("${PYTHON_BIN}" -m uvicorn backend.routes:app --host "${HOST}" --port "${PORT}" --log-level "${LOG_LEVEL}")
  if [[ "${RELOAD}" == "true" ]]; then
    UVICORN_CMD+=("--reload")
  fi
  # For multiple workers, use --workers only in non-reload mode (uvicorn ignores workers with reload)
  if [[ "${WORKERS}" -gt 1 && "${RELOAD}" != "true" ]]; then
    UVICORN_CMD+=("--workers" "${WORKERS}")
  elif [[ "${WORKERS}" -gt 1 && "${RELOAD}" == "true" ]]; then
    echo "Note: --reload is enabled; uvicorn will run single-process reload. To use workers disable --reload."
  fi

  # Exec so signals are forwarded correctly
  exec "${UVICORN_CMD[@]}"
fi

# Mode: transcribe (local file test)
if [[ "${MODE}" == "transcribe" ]]; then
  if [[ -z "${TEST_FILE}" ]]; then
    echo "Missing file path for --test-transcribe"
    exit 1
  fi
  if [[ ! -f "${TEST_FILE}" ]]; then
    echo "File not found: ${TEST_FILE}"
    exit 1
  fi

  echo "Running local transcription test for: ${TEST_FILE}"
  "${PYTHON_BIN}" - <<PY
import json, sys
try:
    from backend.transcribe import transcribe_local_file
except Exception as e:
    print("Failed to import transcribe module:", e, file=sys.stderr)
    raise
res = transcribe_local_file("${TEST_FILE}", split_seconds=None, tmp_dir="/tmp")
print(json.dumps(res, indent=2))
PY
  exit 0
fi

# Mode: pii detection test
if [[ "${MODE}" == "pii" ]]; then
  if [[ -z "${TEST_TEXT}" ]]; then
    echo "Missing text for --test-pii"
    exit 1
  fi

  echo "Running local PII detection test"
  "${PYTHON_BIN}" - <<PY
import json, sys
try:
    from backend.pii_detector import detect_pii, redact_pii
except Exception as e:
    print("Failed to import pii_detector:", e, file=sys.stderr)
    raise
txt = """${TEST_TEXT}"""
redacted, report = redact_pii(txt)
print("REPORT:")
print(json.dumps(report, indent=2))
print("\nREDACTED:")
print(redacted)
PY
  exit 0
fi

# Fallback
echo "Unknown mode: ${MODE}"
usage
