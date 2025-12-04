# backend/embedding.py
"""
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
"""
from __future__ import annotations

import os
import json
import logging
import hashlib
from typing import List, Union, Optional, Any

import numpy as np

logger = logging.getLogger("backend.embedding")
_log_level_name = os.getenv("LOG_LEVEL", "INFO").upper()
logger.setLevel(getattr(logging, _log_level_name, logging.INFO))

# Provider selection flags (populated during import)
_USE_ST_MODEL = False
_USE_OPENAI = False

# Placeholder provider references
_st_model = None  # sentence-transformers model instance if available

# Default fallback embedding dimension (can be adjusted by provider at runtime)
EMBEDDING_DIM: int = int(os.getenv("FALLBACK_EMBEDDING_DIM", "512"))

# -------------------------
# Try sentence-transformers provider (optional)
# -------------------------
try:
    from sentence_transformers import SentenceTransformer  # type: ignore

    try:
        _ST_MODEL_NAME = os.getenv("ST_MODEL_NAME", "all-MiniLM-L6-v2")
        _st_model = SentenceTransformer(_ST_MODEL_NAME)
        _USE_ST_MODEL = True
        EMBEDDING_DIM = int(_st_model.get_sentence_embedding_dimension())
        logger.info("sentence-transformers available: model=%s dim=%d", _ST_MODEL_NAME, EMBEDDING_DIM)
    except Exception:
        logger.exception("Failed to initialize sentence-transformers model; disabling ST provider")
        _st_model = None
        _USE_ST_MODEL = False
except Exception:
    _st_model = None
    _USE_ST_MODEL = False

# -------------------------
# Try OpenAI provider (optional)
# -------------------------
try:
    import openai  # type: ignore

    _openai_key = os.getenv("OPENAI_API_KEY")
    if _openai_key:
        openai.api_key = _openai_key
        # We'll enable OpenAI provider as available (used if ST not present or when chosen).
        _USE_OPENAI = True
        # keep EMBEDDING_DIM conservative until first response sets it
        try:
            EMBEDDING_DIM = int(os.getenv("OPENAI_EMBED_DIM", str(EMBEDDING_DIM)))
        except Exception:
            pass
        logger.info("OpenAI client available for embeddings (model env: %s)", os.getenv("OPENAI_EMBEDDING_MODEL"))
    else:
        _USE_OPENAI = False
except Exception:
    _USE_OPENAI = False

logger.debug("embedding providers: use_st=%s use_openai=%s dim=%d", _USE_ST_MODEL, _USE_OPENAI, EMBEDDING_DIM)


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

    # sentence-transformers path (fast, local)
    if _USE_ST_MODEL and _st_model is not None:
        vec = _st_model.encode(text, convert_to_numpy=True)
        arr = np.asarray(vec, dtype=np.float32)
        if arr.ndim != 1:
            arr = arr.reshape(-1)
        # update global dim if it differs
        global EMBEDDING_DIM
        if arr.size != EMBEDDING_DIM:
            EMBEDDING_DIM = int(arr.size)
            logger.debug("Adjusted EMBEDDING_DIM to %d from sentence-transformers", EMBEDDING_DIM)
        return arr

    # OpenAI path (best-effort). Update EMBEDDING_DIM from response.
    if _USE_OPENAI:
        try:
            model = os.getenv("OPENAI_EMBEDDING_MODEL", "text-embedding-3-small")
            resp = openai.Embedding.create(input=[text], model=model)
            emb = resp["data"][0]["embedding"]
            arr = np.asarray(emb, dtype=np.float32)
            global EMBEDDING_DIM
            EMBEDDING_DIM = int(arr.size)
            return arr
        except Exception:
            logger.exception("OpenAI embedding call failed; falling back to local deterministic embedding")

    # Deterministic local fallback
    return _fallback_embed(text)


def embed_batch(texts: List[str]) -> Union[List[np.ndarray], np.ndarray]:
    """
    Embed a batch of texts. Returns either a list of 1-D numpy float32 arrays or a 2-D numpy array.
    """
    if texts is None:
        raise TypeError("texts must be an iterable of strings")
    # coerce to list for multiple passes
    if not isinstance(texts, (list, tuple)):
        texts = list(texts)

    # sentence-transformers batch path
    if _USE_ST_MODEL and _st_model is not None:
        vecs = _st_model.encode(texts, convert_to_numpy=True)
        arr = np.asarray(vecs, dtype=np.float32)
        if arr.ndim == 1:
            arr = arr.reshape(1, -1)
        global EMBEDDING_DIM
        EMBEDDING_DIM = int(arr.shape[1])
        # return list to be consistent with single-item embed
        return [arr[i] for i in range(arr.shape[0])]

    # OpenAI batch path (best-effort)
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

    # fallback: compute one-by-one deterministically
    return [_fallback_embed(t) for t in texts]


# -------------------------
# Deterministic fallback implementation
# -------------------------
def _fallback_embed(text: str) -> np.ndarray:
    """
    Deterministic, purely local embedding generator based on iterative SHA-256 hashing.
    Produces EMBEDDING_DIM floats in [-0.5, +0.5], then returns the vector normalized to unit length.
    """
    dim = int(EMBEDDING_DIM)
    buf = np.empty(dim, dtype=np.float32)
    text_bytes = (text or "").encode("utf-8")
    for i in range(dim):
        h = hashlib.sha256()
        h.update(text_bytes)
        h.update(b"\x00")
        h.update(str(i).encode("utf-8"))
        digest = h.digest()
        # use first 4 bytes as uint32 big-endian
        v = int.from_bytes(digest[0:4], "big")
        f = v / float(2 ** 32)  # in [0,1)
        buf[i] = float(f - 0.5)  # center around zero
    norm = np.linalg.norm(buf)
    if norm == 0.0:
        return np.zeros(dim, dtype=np.float32)
    return (buf / norm).astype(np.float32)


# -------------------------
# Optional persistence utilities
# -------------------------
def persist(vec: Union[List[float], np.ndarray], meta_or_path: Union[str, dict], path: Optional[str] = None) -> None:
    """
    Persist a single embedding vector to disk.

    Signatures:
      persist(vec, "/tmp/emb.npz")
      persist(vec, {"meta":...}, path="/tmp/emb.npz")
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
    if isinstance(meta_or_path, dict):
        try:
            with open(base + "_meta.json", "w", encoding="utf-8") as fh:
                json.dump(meta_or_path, fh, ensure_ascii=False, indent=2)
        except Exception:
            logger.exception("Failed to write metadata alongside embedding")


def load(path: str) -> np.ndarray:
    """
    Load a persisted embedding saved via persist.
    Accepts a path with or without extension; loads <base>.npy.
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
