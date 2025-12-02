"""
backend/embedding.py

Pluggable, deterministic embedding provider used by the speech_to_insights project.

Behavior:
- Try these providers in order:
  1) sentence-transformers (if installed) using a compact model.
  2) OpenAI embeddings (if openai package installed and OPENAI_API_KEY set).
  3) Deterministic local fallback based on iterative SHA-256 hashing (guaranteed reproducible).
- Exposes a minimal, stable API expected by tests and other modules:
    - EMBEDDING_DIM            : int
    - embed(text: str) -> np.ndarray
    - embed_batch(texts: list[str]) -> List[np.ndarray] or np.ndarray
    - persist(vec, meta_or_path, path=...)  (optional convenience for tests/CI)
    - load(path) -> np.ndarray
- Deterministic: same input -> identical vector. Fallback ensures determinism even without external libs.
- Vectors are numpy arrays dtype float32.

Notes:
- This module is intentionally defensive: it will not raise on missing optional dependencies
  until you attempt to use that provider. Fallback always works.
"""

from __future__ import annotations

import os
import json
import logging
import hashlib
from typing import List, Union, Optional, Any

import numpy as np

logger = logging.getLogger("embedding")
_log_level_name = os.getenv("LOG_LEVEL", "INFO").upper()
logger.setLevel(getattr(logging, _log_level_name, logging.INFO))

# Provider selection flags (populated during import)
_USE_ST_MODEL = False
_USE_OPENAI = False

# Attempt to import sentence_transformers
try:
    from sentence_transformers import SentenceTransformer  # type: ignore

    try:
        # choose a compact model that is likely available or will be downloaded on first run
        _ST_MODEL_NAME = os.getenv("ST_MODEL_NAME", "all-MiniLM-L6-v2")
        _st_model = SentenceTransformer(_ST_MODEL_NAME)
        _USE_ST_MODEL = True
        EMBEDDING_DIM = _st_model.get_sentence_embedding_dimension()
        logger.info("Using sentence-transformers model %s (dim=%d)", _ST_MODEL_NAME, EMBEDDING_DIM)
    except Exception:
        logger.exception("Failed to initialize sentence-transformers model; falling back")
        _USE_ST_MODEL = False
        _st_model = None  # type: ignore
except Exception:
    _st_model = None  # type: ignore
    _USE_ST_MODEL = False

# Attempt to import OpenAI client if available and api key present
try:
    import openai  # type: ignore

    _openai_key = os.getenv("OPENAI_API_KEY")
    if _openai_key:
        openai.api_key = _openai_key
        # We'll use OpenAI only if sentence-transformers not available (best-effort)
        _USE_OPENAI = True
        # OpenAI embedding dimension depends on model; set a default and adjust after first call.
        EMBEDDING_DIM = int(os.getenv("OPENAI_EMBED_DIM", "1536"))
        logger.info("OpenAI client available; embeddings can use OpenAI when selected")
    else:
        _USE_OPENAI = False
except Exception:
    _USE_OPENAI = False

# If neither provider succeeded, set fallback dimension
if not (_USE_ST_MODEL or _USE_OPENAI):
    EMBEDDING_DIM = int(os.getenv("FALLBACK_EMBEDDING_DIM", "512"))
    logger.info("Using local deterministic fallback embeddings (dim=%d)", EMBEDDING_DIM)


# -------------------------
# Public API
# -------------------------
def embed(text: str) -> np.ndarray:
    """
    Embed a single text string. Returns a 1-D numpy float32 array of length EMBEDDING_DIM.
    Deterministic: same input -> same output.
    """
    if not isinstance(text, str):
        raise TypeError("text must be a string")
    # Fast path: sentence-transformers
    if _USE_ST_MODEL and _st_model is not None:
        vec = _st_model.encode(text, convert_to_numpy=True)
        vec = np.asarray(vec, dtype=np.float32)
        # Ensure shape and dimension
        if vec.ndim == 1 and vec.size == EMBEDDING_DIM:
            return vec
        # If model returned different dim (unlikely), adjust global var
        global EMBEDDING_DIM
        EMBEDDING_DIM = int(vec.size)
        return vec

    # OpenAI path (best-effort). We call synchronously and update EMBEDDING_DIM if possible.
    if _USE_OPENAI:
        try:
            model = os.getenv("OPENAI_EMBEDDING_MODEL", "text-embedding-3-small")
            resp = openai.Embedding.create(input=[text], model=model)
            emb = resp["data"][0]["embedding"]
            vec = np.asarray(emb, dtype=np.float32)
            global EMBEDDING_DIM
            EMBEDDING_DIM = int(vec.size)
            return vec
        except Exception:
            logger.exception("OpenAI embedding call failed; falling back to local embedding")

    # Fallback deterministic hashing-based embedding
    return _fallback_embed(text)


def embed_batch(texts: List[str]) -> List[np.ndarray]:
    """
    Embed a batch of texts. Returns a list of 1-D numpy arrays (dtype float32).
    Implementations may return a numpy array (n x dim) but tests accept list or array.
    """
    if texts is None:
        raise TypeError("texts must be an iterable of strings")
    # sentence-transformers batch path
    if _USE_ST_MODEL and _st_model is not None:
        vecs = _st_model.encode(texts, convert_to_numpy=True)
        arr = np.asarray(vecs, dtype=np.float32)
        # Ensure consistent shape and dim
        if arr.ndim == 1:
            arr = arr.reshape(1, -1)
        return [arr[i] for i in range(arr.shape[0])]

    # OpenAI batch path (creates multiple inputs in one call)
    if _USE_OPENAI:
        try:
            model = os.getenv("OPENAI_EMBEDDING_MODEL", "text-embedding-3-small")
            resp = openai.Embedding.create(input=texts, model=model)
            out = [np.asarray(item["embedding"], dtype=np.float32) for item in resp["data"]]
            if out:
                global EMBEDDING_DIM
                EMBEDDING_DIM = int(out[0].size)
            return out
        except Exception:
            logger.exception("OpenAI batch embedding failed; falling back to local embedding")

    # fallback: use local for each item
    return [_fallback_embed(t) for t in texts]


# -------------------------
# Deterministic fallback implementation
# -------------------------
def _fallback_embed(text: str) -> np.ndarray:
    """
    Deterministic, purely local embedding generator based on iterative SHA-256 hashing.
    Produces EMBEDDING_DIM floats in [-0.5, +0.5], then returns the vector normalized to unit length.
    Same input -> identical vector. Different inputs -> usually low cosine similarity.

    Implementation detail:
      For each dimension i, compute sha256(f"{text}\x00{i}") and extract 4 bytes -> uint32 -> float in [0,1).
      Map to [-0.5, 0.5] and finally L2-normalize.
    """
    dim = int(EMBEDDING_DIM)
    buf = np.empty(dim, dtype=np.float32)
    # guard empty string but allow it
    text_bytes = (text or "").encode("utf-8")
    for i in range(dim):
        h = hashlib.sha256()
        # include dimension index and a small separator for clarity
        h.update(text_bytes)
        h.update(b"\x00")
        h.update(str(i).encode("utf-8"))
        digest = h.digest()
        # use first 4 bytes as uint32 in big-endian
        v = int.from_bytes(digest[0:4], "big")
        # scale to [0,1)
        f = v / float(2 ** 32)
        buf[i] = float(f - 0.5)  # center around zero
    # normalize (protect against zero vector)
    norm = np.linalg.norm(buf)
    if norm == 0.0:
        # extremely unlikely, but handle gracefully
        return np.zeros(dim, dtype=np.float32)
    return (buf / norm).astype(np.float32)


# -------------------------
# Optional persistence utilities (used by tests if present)
# -------------------------
def persist(vec: Union[List[float], np.ndarray], meta_or_path: Union[str, dict], path: Optional[str] = None) -> None:
    """
    Persist a single embedding vector to disk.
    Flexible signatures supported by tests:
      persist(vec, meta_dict, path="/tmp/emb.npz")
      or persist(vec, "/tmp/emb.npz")
    Behavior:
      - If meta_or_path is a string and path is None: treat meta_or_path as file path and save vector only (.npy)
      - If meta_or_path is a dict and path provided: save vector (.npy) and metadata (.json) next to it.
    """
    arr = np.asarray(vec, dtype=np.float32)
    if isinstance(meta_or_path, str) and path is None:
        out_path = meta_or_path
        base = out_path.rsplit(".", 1)[0]
        np.save(base + ".npy", arr)
        return

    if path is None:
        raise TypeError("When providing metadata, supply 'path' argument for output file")
    out_path = path
    base = out_path.rsplit(".", 1)[0]
    np.save(base + ".npy", arr)
    # write metadata (if dict)
    if isinstance(meta_or_path, dict):
        try:
            with open(base + "_meta.json", "w", encoding="utf-8") as fh:
                json.dump(meta_or_path, fh, ensure_ascii=False, indent=2)
        except Exception:
            logger.exception("Failed to write metadata alongside embedding")


def load(path: str) -> np.ndarray:
    """
    Load a persisted embedding saved via persist. Accepts either:
      - path pointing to .npy file
      - path pointing to base name (with or without extension)
    Returns numpy ndarray dtype float32.
    """
    base = path.rsplit(".", 1)[0]
    npy = base + ".npy"
    if not os.path.exists(npy):
        raise FileNotFoundError(f"Embedding file not found: {npy}")
    arr = np.load(npy)
    return np.asarray(arr, dtype=np.float32)


# -------------------------
# Module exports
# -------------------------
__all__ = [
    "EMBEDDING_DIM",
    "embed",
    "embed_batch",
    "persist",
    "load",
]
