# backend/test_embedding_contract.py
"""
Pytest contract tests for the embedding module.

Goals:
- Ensure embedding API surface exists and returns the expected types/shapes.
- Check basic properties: dimension, dtype, determinism (same input -> same vector),
  basic similarity behavior (identical inputs -> high cosine similarity; different inputs -> lower).
- Test batch behavior (list input -> array of embeddings).

Notes:
- These are contract tests: conservative and informative.
- If your embedding implementation differs in naming, adapt the import lines or provide shims
  in backend/embedding.py (recommended: functions named `embed(text)` and `embed_batch(texts)`).
"""

import os
import importlib
from typing import List

import numpy as np
import pytest

# Try to import the project's embedding module. If it doesn't exist, skip tests with helpful message.
embedding = pytest.importorskip(
    "backend.embedding",
    reason="backend.embedding module not found. Create backend/embedding.py exposing `embed` and `embed_batch`."
)


# --- Helpers -----------------------------------------------------------------
def _to_ndarray(vec):
    """Coerce list/tuple or numpy-like to numpy array for consistent checks (dtype preserved when possible)."""
    if isinstance(vec, np.ndarray):
        return vec
    return np.asarray(vec)


def _to_ndarray_strict(vec):
    """Return numpy float32 array for stricter dtype checks."""
    if isinstance(vec, np.ndarray):
        return vec.astype(np.float32)
    return np.asarray(vec, dtype=np.float32)


def _cosine_sim(a, b):
    a = _to_ndarray(a)
    b = _to_ndarray(b)
    na = np.linalg.norm(a)
    nb = np.linalg.norm(b)
    if na == 0 or nb == 0:
        return 0.0
    return float(np.dot(a, b) / (na * nb))


# --- Discovery / configuration -----------------------------------------------
# Acceptable attribute names to discover embedding functions
_EMBED_FN_NAMES = ("embed", "generate_embedding", "get_embedding", "create_embedding")
_BATCH_FN_NAMES = ("embed_batch", "generate_embeddings", "get_embeddings", "create_embeddings")

embed_fn = None
embed_batch_fn = None

for name in _EMBED_FN_NAMES:
    if hasattr(embedding, name):
        embed_fn = getattr(embedding, name)
        break

for name in _BATCH_FN_NAMES:
    if hasattr(embedding, name):
        embed_batch_fn = getattr(embedding, name)
        break

# If batch function not present but single embed exists, create a small wrapper
if embed_batch_fn is None and embed_fn is not None:
    def embed_batch_fn(texts: List[str]):
        return [embed_fn(t) for t in texts]

# Discover expected embedding dimension if provided; otherwise fall back to common defaults
expected_dim = getattr(embedding, "EMBEDDING_DIM", None)
if expected_dim is None:
    try:
        expected_dim = int(os.environ.get("EMBEDDING_DIM", ""))
    except Exception:
        expected_dim = None

# Common reasonable dims
DEFAULT_EXPECTED_DIMS = (1536, 1024, 768, 512, 384, 256, 128)
if expected_dim is None:
    inferred_expected_dim = None
else:
    inferred_expected_dim = int(expected_dim)


# --- Tests -------------------------------------------------------------------
def test_api_surface():
    """Embedding module exposes a usable API."""
    assert embed_fn is not None, (
        "No single-item embed function found. Implement one of: "
        + ", ".join(_EMBED_FN_NAMES)
    )
    assert callable(embed_fn), "Discovered embed function is not callable"
    assert embed_batch_fn is not None, (
        "No batch embed function found and cannot wrap single-item embed; "
        "implement one of: " + ", ".join(_BATCH_FN_NAMES)
    )
    assert callable(embed_batch_fn), "Discovered embed_batch function is not callable"


@pytest.mark.parametrize("text", [
    "hello world",
    "The quick brown fox jumps over the lazy dog.",
    "Aaku is testing embeddings."
])
def test_embedding_returns_numeric_vector(text):
    """Single input returns a numeric 1-D vector with finite values."""
    vec = embed_fn(text)
    arr = _to_ndarray(vec)
    assert arr.ndim == 1, f"Embedding must be 1-D. Got shape {arr.shape}"
    assert arr.size > 0, "Embedding must contain at least one element"
    assert np.isfinite(arr).all(), "Embedding contains non-finite values (NaN/Inf)"
    # dtype check (allow float32 or float64)
    assert arr.dtype.kind == "f", f"Unexpected dtype {arr.dtype}; embeddings should be floats"


def test_infer_dimension_and_match_expected():
    """If module provides EMBEDDING_DIM, embeddings must match it. Otherwise infer safe default."""
    sample = "dimension inferencing sample"
    vec = _to_ndarray(embed_fn(sample))
    dim = int(vec.size)
    global inferred_expected_dim
    if inferred_expected_dim is None:
        # Accept common defaults but fail loudly otherwise
        assert dim in DEFAULT_EXPECTED_DIMS, (
            f"Inferred embedding dimension {dim} is unusual. "
            "If this is expected, set EMBEDDING_DIM in backend/embedding.py or set env EMBEDDING_DIM for CI."
        )
        inferred_expected_dim = dim
    else:
        assert dim == inferred_expected_dim, f"Embedding dimension {dim} != expected {inferred_expected_dim}"


def _coerce_batch_to_ndarray(batch_out):
    """
    Coerce embed_batch output to a 2-D numpy array (n x d).
    Accepts: numpy array (n,d), list of arrays/lists, generator.
    """
    if isinstance(batch_out, np.ndarray):
        arr = batch_out
    else:
        try:
            seq = list(batch_out)
        except TypeError:
            pytest.fail("embed_batch returned unexpected non-iterable type: %s" % type(batch_out))
        # convert each item to ndarray, allow items that are numpy arrays or sequences
        rows = []
        for x in seq:
            a = _to_ndarray(x)
            if a.ndim != 1:
                # try to flatten if possible
                a = a.reshape(-1)
            rows.append(a)
        # ensure consistent dimension
        lengths = [r.size for r in rows]
        if len(set(lengths)) != 1:
            pytest.fail(f"embed_batch returned rows with inconsistent dimensions: {lengths}")
        arr = np.asarray([r for r in rows])
    return arr


def test_batch_behavior_and_shapes():
    """Batch call returns list/array of embeddings matching the number of inputs and expected dim."""
    texts = ["alpha", "beta", "gamma"]
    batch_out = embed_batch_fn(texts)

    arr = _coerce_batch_to_ndarray(batch_out)
    assert arr.ndim == 2, f"Batch embeddings must be 2-D (n x dim). Got shape {arr.shape}"
    n, d = arr.shape
    assert n == len(texts), f"Batch produced {n} embeddings for {len(texts)} inputs"
    # set inferred_expected_dim if not yet set
    global inferred_expected_dim
    if inferred_expected_dim is None:
        inferred_expected_dim = int(d)
        assert inferred_expected_dim in DEFAULT_EXPECTED_DIMS, (
            f"Inferred embedding dim {inferred_expected_dim} unusual. Set EMBEDDING_DIM if this is expected."
        )
    else:
        assert d == inferred_expected_dim, f"Batch embedding dim {d} != expected {inferred_expected_dim}"


def test_determinism_same_input():
    """Same input text should yield (nearly) identical embeddings on repeated calls."""
    text = "determinism test input"
    v1 = _to_ndarray_strict(embed_fn(text))
    v2 = _to_ndarray_strict(embed_fn(text))
    assert v1.shape == v2.shape, "Repeated embedding shapes differ"
    # Tight numeric equality if implementation deterministic; allow tiny numerical jitter
    if np.allclose(v1, v2, rtol=1e-6, atol=1e-6):
        return
    sim = _cosine_sim(v1, v2)
    assert sim > 0.999, f"Embeddings for identical text differ (cosine sim={sim:.6f}). Embed function should be deterministic."


def test_similarity_behaviour():
    """Simple sanity: identical inputs -> very high cosine similarity; different inputs -> lower similarity."""
    a = "the cat sat on the mat"
    b = "the cat sat on the mat"
    c = "quantum entanglement and particle physics experimental methods"

    va = _to_ndarray(embed_fn(a))
    vb = _to_ndarray(embed_fn(b))
    vc = _to_ndarray(embed_fn(c))

    sim_same = _cosine_sim(va, vb)
    sim_diff = _cosine_sim(va, vc)

    assert sim_same > 0.99, f"Identical inputs should have very high similarity. got {sim_same:.6f}"
    # Different topic should be noticeably lower; threshold conservative
    assert sim_diff < 0.9, f"Different inputs too similar (cosine {sim_diff:.6f}). Expected < 0.9"


def test_nonzero_norm():
    """Embeddings should not be all-zero vectors."""
    sample = "non-zero check"
    vec = _to_ndarray(embed_fn(sample))
    norm = float(np.linalg.norm(vec))
    assert norm > 1e-6, f"Embedding vector norm is suspiciously small ({norm}). Should be non-zero."


def test_batch_consistency_with_single_calls():
    """Embedding a batch should be consistent with calling the single-item API repeatedly."""
    texts = ["one", "two", "three", "four"]
    batch = embed_batch_fn(texts)
    batch_arr = _coerce_batch_to_ndarray(batch).astype(float)

    singles = np.asarray([_to_ndarray(embed_fn(t)) for t in texts], dtype=float)
    assert batch_arr.shape == singles.shape, "Batch and repeated single calls produced different shapes"
    assert np.allclose(batch_arr, singles, rtol=1e-6, atol=1e-6), "Batch embeddings differ from repeated single embeddings"


# Optional: storage contract test (if the embedding module provides a persistence API)
def test_optional_persistence_contract(tmp_path):
    """
    If embedding module exposes `persist(embedding, id_or_meta, path=...)` and `load(path)` functions,
    test they work. This is optional and skipped if not present.
    """
    if not (hasattr(embedding, "persist") and hasattr(embedding, "load")):
        pytest.skip("No persistence API (persist/load) on embedding module; skipping persistence contract test")

    sample_text = "persistence contract test"
    vec = _to_ndarray(embed_fn(sample_text))
    meta = {"text": sample_text}
    p = tmp_path / "emb.npz"
    # call persist; allow both (embedding, meta, path=...) or (vector, id, path)
    try:
        embedding.persist(vec, meta, path=str(p))
    except TypeError:
        # try alternate signature
        embedding.persist(vec, str(p))

    loaded = embedding.load(str(p))
    loaded_arr = _to_ndarray(loaded)
    assert np.allclose(loaded_arr, vec, rtol=1e-6, atol=1e-6), "Loaded embedding differs from persisted embedding"
