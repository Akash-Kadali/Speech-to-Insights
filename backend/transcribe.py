# backend/transcribe.py

"""
Orchestration layer for ingestion -> preprocessing -> transcription.

Responsibilities
- Accept local audio files or S3 URIs.
- Normalize audio (sample rate, mono) using ffmpeg (shell call).
- Optionally split long audio into fixed-length chunks (seconds).
- For local run: either call whisper.transcribe_bytes_realtime for short files
  or upload chunks to S3 and return S3 URIs (to be picked up by batch transform).
- For S3 run: decide realtime vs transform via whisper.process_s3_event_and_transcribe
  or prepare S3 inputs for batch transform.
- Provide a CLI for quick local testing and a programmatic API for integration.

Notes:
- This updated file includes safer S3 parsing, ffmpeg availability checks,
  improved logging, optional immediate transform kick-off via whisper, and
  clearer return metadata for programmatic use.
"""

from __future__ import annotations

import os
import uuid
import json
import logging
import subprocess
import tempfile
import shutil
import mimetypes
from pathlib import Path
from typing import List, Dict, Tuple, Optional, Any

# boto3 import defensively (some test environments won't have AWS SDK)
try:
    import boto3  # type: ignore
    from botocore.exceptions import ClientError  # type: ignore
    _BOTO3_AVAILABLE = True
except Exception:
    boto3 = None  # type: ignore
    ClientError = Exception
    _BOTO3_AVAILABLE = False

# Local whisper module (best-effort)
try:
    # prefer package-local import
    from . import whisper as whisper_module  # type: ignore
except Exception:
    whisper_module = None  # type: ignore

logger = logging.getLogger("transcribe")
logger.setLevel(os.getenv("LOG_LEVEL", "INFO").upper())
if not logger.handlers:
    ch = logging.StreamHandler()
    ch.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
    logger.addHandler(ch)

# Lazy S3 client
_s3_client = None


def _get_s3_client():
    global _s3_client
    if _s3_client is None:
        if not _BOTO3_AVAILABLE:
            raise RuntimeError("boto3 is not available in this environment")
        # allow region override by env
        region = os.getenv("AWS_REGION") or os.getenv("AWS_DEFAULT_REGION")
        if region:
            _s3_client = boto3.client("s3", region_name=region)
        else:
            _s3_client = boto3.client("s3")
    return _s3_client


# -------------------------
# Utilities
# -------------------------
def is_s3_uri(uri: str) -> bool:
    return isinstance(uri, str) and uri.startswith("s3://")


def parse_s3_uri(uri: str) -> Tuple[str, str]:
    """
    Parse an s3://bucket/key... string and return (bucket, key).
    Raises ValueError on malformed URIs.
    """
    if not isinstance(uri, str) or not uri:
        raise ValueError("s3 uri must be a non-empty string")
    if not uri.startswith("s3://"):
        raise ValueError("Not an S3 URI: " + str(uri))
    parts = uri[5:].split("/", 1)
    if len(parts) < 2 or not parts[1]:
        raise ValueError("S3 URI must include a key: " + str(uri))
    bucket = parts[0]
    key = parts[1]
    return bucket, key


def ffmpeg_available() -> bool:
    """Return True if ffmpeg binary is available on PATH."""
    try:
        subprocess.check_call(["ffmpeg", "-version"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        return True
    except Exception:
        return False


def run_ffmpeg_normalize(input_path: str, output_path: str, sample_rate: int = 16000) -> None:
    """
    Normalize audio:
    - convert to WAV PCM 16-bit
    - set sample rate to `sample_rate`
    - mono channel
    Relies on ffmpeg binary available on PATH.
    Throws RuntimeError on failure.
    """
    if not ffmpeg_available():
        raise RuntimeError("ffmpeg not found on PATH. Install ffmpeg to use normalization.")

    cmd = [
        "ffmpeg",
        "-y",  # overwrite
        "-hide_banner",
        "-loglevel", "error",
        "-i", input_path,
        "-ar", str(sample_rate),
        "-ac", "1",
        "-acodec", "pcm_s16le",
        output_path,
    ]
    logger.debug("Running ffmpeg: %s", " ".join(cmd))
    try:
        subprocess.check_call(cmd)
    except subprocess.CalledProcessError as e:
        logger.exception("ffmpeg normalization failed for %s -> %s", input_path, output_path)
        raise RuntimeError(f"ffmpeg failed: {e}")


def split_audio_by_seconds(input_wav: str, seconds: int, out_dir: str) -> List[str]:
    """
    Split a normalized WAV into sequential chunks each `seconds` long using ffmpeg.
    Returns list of chunk file paths.
    """
    if seconds <= 0:
        raise ValueError("split_seconds must be > 0")

    out_dir_path = Path(out_dir)
    out_dir_path.mkdir(parents=True, exist_ok=True)

    base_template = str(out_dir_path / "chunk-%04d.wav")
    cmd = [
        "ffmpeg",
        "-y",
        "-hide_banner",
        "-loglevel", "error",
        "-i", input_wav,
        "-f", "segment",
        "-segment_time", str(seconds),
        "-c", "copy",
        base_template,
    ]
    logger.debug("Splitting audio with ffmpeg: %s", " ".join(cmd))
    try:
        subprocess.check_call(cmd)
    except subprocess.CalledProcessError:
        logger.exception("ffmpeg segmenting failed for %s", input_wav)
        raise RuntimeError("ffmpeg segmenting failed")

    chunks = sorted([str(p) for p in out_dir_path.glob("chunk-*.wav")])
    logger.info("Created %d chunks under %s", len(chunks), out_dir)
    return chunks


def upload_file_to_s3(local_path: str, bucket: str, key: str) -> str:
    """
    Upload local_path to s3://bucket/key and return s3://... URI on success.
    """
    logger.info("Uploading %s -> s3://%s/%s", local_path, bucket, key)
    s3 = _get_s3_client()
    try:
        s3.upload_file(local_path, bucket, key)
    except ClientError as e:
        logger.exception("S3 upload failed: %s", e)
        raise
    return f"s3://{bucket}/{key}"


# -------------------------
# High-level flows
# -------------------------
def transcribe_local_file(
    input_file: str,
    *,
    split_seconds: Optional[int] = None,
    tmp_dir: Optional[str] = None,
    s3_output_bucket: Optional[str] = None,
    s3_output_prefix: Optional[str] = None,
    realtime_threshold_bytes: Optional[int] = None,
    kick_off_transform: bool = True,
) -> Dict[str, Any]:
    """
    Transcribe a local audio file.

    Parameters:
    - input_file: path to local audio
    - split_seconds: optional chunk duration (seconds)
    - tmp_dir: optional temp dir
    - s3_output_bucket: bucket name where normalized/chunk files will be uploaded (bucket only)
    - s3_output_prefix: prefix inside the bucket for uploads
    - realtime_threshold_bytes: override threshold (bytes)
    - kick_off_transform: if True and whisper supports transform, attempt to start transform automatically

    Returns a dict describing action taken and metadata:
    - realtime: transcript returned
    - uploaded_chunks: list of s3 inputs
    - transform_kicked: whisper transform response
    - error: on failure
    """
    caller_provided_tmp = tmp_dir is not None
    if not caller_provided_tmp:
        tmp_dir = tempfile.mkdtemp(prefix="transcribe-")
    tmp_path = Path(tmp_dir)
    tmp_path.mkdir(parents=True, exist_ok=True)
    created_tmp = not caller_provided_tmp

    try:
        # Step 1: normalize
        normalized = str(tmp_path / f"normalized-{uuid.uuid4().hex}.wav")
        logger.info("Normalizing %s -> %s", input_file, normalized)
        run_ffmpeg_normalize(input_file, normalized)

        # Determine size and thresholds
        file_size = Path(normalized).stat().st_size
        threshold = realtime_threshold_bytes or getattr(whisper_module, "MAX_REALTIME_BYTES", None) or (5 * 1024 * 1024)
        logger.info("Normalized file size %d bytes, realtime threshold %d bytes", file_size, threshold)

        # If splitting requested
        if split_seconds:
            logger.info("Splitting normalized file into %d-second chunks", split_seconds)
            chunks_dir = str(tmp_path / "chunks")
            chunk_paths = split_audio_by_seconds(normalized, split_seconds, chunks_dir)
            if not chunk_paths:
                raise RuntimeError("Splitting produced no chunks")

            # If S3 configured, upload chunks
            if s3_output_bucket:
                s3_inputs: List[str] = []
                for cp in chunk_paths:
                    key_prefix = (s3_output_prefix.rstrip("/") + "/") if s3_output_prefix else ""
                    s3_key = f"{key_prefix}inputs/{Path(cp).name}"
                    s3_uri = upload_file_to_s3(cp, s3_output_bucket, s3_key)
                    s3_inputs.append(s3_uri)

                result: Dict[str, Any] = {"mode": "uploaded_chunks", "s3_inputs": s3_inputs, "num_chunks": len(s3_inputs)}
                # Caller can start transforms separately; keep behavior conservative
                result["note"] = "chunks_uploaded"
                return result
            else:
                # No S3: attempt realtime per chunk if transcribe_bytes_realtime available
                results: List[Dict[str, Any]] = []
                for cp in chunk_paths:
                    size = Path(cp).stat().st_size
                    if size <= threshold and whisper_module and getattr(whisper_module, "transcribe_bytes_realtime", None):
                        with open(cp, "rb") as fh:
                            out = whisper_module.transcribe_bytes_realtime(fh.read())
                        text = out.get("text", "")
                        results.append({"chunk": Path(cp).name, "text": text, "meta": out})
                    else:
                        results.append({"chunk": Path(cp).name, "text": None, "notice": "too_large_for_realtime_or_no_whisper"})
                return {"mode": "local_chunks_processed", "results": results}

        # No splitting: decide realtime vs batch
        if file_size <= threshold and whisper_module and getattr(whisper_module, "transcribe_bytes_realtime", None):
            logger.info("Using realtime path for normalized file")
            with open(normalized, "rb") as fh:
                audio_bytes = fh.read()
            out = whisper_module.transcribe_bytes_realtime(audio_bytes)
            text = out.get("text", "")
            return {"mode": "realtime", "transcript": text, "meta": out}

        # Otherwise upload normalized file to S3 for batch
        if not s3_output_bucket:
            raise RuntimeError("File too large for realtime and no s3_output_bucket provided for batch transform")

        prefix = (s3_output_prefix.rstrip("/") + "/") if s3_output_prefix else ""
        s3_key = f"{prefix}inputs/{Path(normalized).name}"
        s3_uri = upload_file_to_s3(normalized, s3_output_bucket, s3_key)
        logger.info("Uploaded normalized file to %s", s3_uri)

        # Create a fake S3 record and either call whisper.process_s3_event_and_transcribe
        fake_record = {"s3": {"bucket": {"name": s3_output_bucket}, "object": {"key": s3_key, "size": Path(normalized).stat().st_size}}}

        # If caller wants to start the transform immediately and whisper supports it, attempt it.
        if kick_off_transform and whisper_module and getattr(whisper_module, "process_s3_event_and_transcribe", None):
            try:
                result = whisper_module.process_s3_event_and_transcribe(fake_record)
                return {"mode": "transform_kicked", "s3_input": s3_uri, "result": result}
            except Exception:
                logger.exception("whisper.process_s3_event_and_transcribe failed; returning upload info")
                return {"mode": "uploaded_for_transform", "s3_input": s3_uri, "note": "process_call_failed"}
        else:
            return {"mode": "uploaded_for_transform", "s3_input": s3_uri}
    finally:
        # clean up temp dir if we created it
        if created_tmp and tmp_dir and Path(tmp_dir).exists():
            try:
                shutil.rmtree(tmp_dir)
            except Exception:
                logger.debug("Failed to remove tmp dir %s", tmp_dir)


def transcribe_s3_uri(s3_uri: str) -> Dict[str, Any]:
    """
    Given an s3://bucket/key, call whisper.process_s3_event_and_transcribe to decide realtime vs transform.
    Returns the whisper result (or raises if whisper_module not available).
    """
    if not whisper_module or not getattr(whisper_module, "process_s3_event_and_transcribe", None):
        raise RuntimeError("whisper.process_s3_event_and_transcribe not available")
    bucket, key = parse_s3_uri(s3_uri)
    fake_record = {"s3": {"bucket": {"name": bucket}, "object": {"key": key}}}
    return whisper_module.process_s3_event_and_transcribe(fake_record)


# -------------------------
# CLI
# -------------------------
def _cli():
    import argparse

    parser = argparse.ArgumentParser(description="Transcription orchestration CLI (local and s3).")
    sub = parser.add_subparsers(dest="cmd", required=True)

    local = sub.add_parser("local", help="Transcribe a local audio file")
    local.add_argument("--file", required=True, help="Local audio file path")
    local.add_argument("--split-seconds", type=int, default=None, help="Split into chunks (seconds)")
    local.add_argument("--s3-bucket", default=os.getenv("TRANSFORM_INPUT_BUCKET"), help="S3 bucket to upload chunks / normalized file (bucket name only)")
    local.add_argument("--s3-prefix", default=os.getenv("TRANSFORM_INPUT_PREFIX", "speech-to-insights"), help="S3 prefix for uploads")
    local.add_argument("--tmp-dir", default=None, help="Temporary working directory")
    local.add_argument("--realtime-threshold-bytes", type=int, default=None, help="Override realtime threshold")
    local.add_argument("--no-auto-transform", action="store_true", help="Do not attempt to auto-start transform after upload")

    s3 = sub.add_parser("s3", help="Trigger transcription flow for an existing S3 object")
    s3.add_argument("--s3-uri", required=True, help="s3://bucket/key")

    args = parser.parse_args()

    if args.cmd == "local":
        res = transcribe_local_file(
            args.file,
            split_seconds=args.split_seconds,
            tmp_dir=args.tmp_dir,
            s3_output_bucket=args.s3_bucket,
            s3_output_prefix=args.s3_prefix,
            realtime_threshold_bytes=args.realtime_threshold_bytes,
            kick_off_transform=(not args.no_auto_transform),
        )
        print(json.dumps(res, indent=2))
    elif args.cmd == "s3":
        res = transcribe_s3_uri(args.s3_uri)
        print(json.dumps(res, indent=2))
    else:
        parser.error("unknown command")


if __name__ == "__main__":
    _cli()
