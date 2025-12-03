# backend/indexer.py
"""
Final upgraded Vector index module for speech_to_insights.

Features / improvements:
- Supports faiss backend (if available) with proper normalization for cosine search.
- Robust numpy fallback with cosine similarity linear scan.
- Batch embedding discovery: accepts embed, embed_batch, generate_embedding, etc.
- Chunking support with overlap and chunk metadata.
- Persistent storage:
    <base>.npy         -> vectors (float32) for numpy fallback
    <base>_meta.json   -> metadata list aligned with vectors
    <base>_ids.json    -> ids list aligned with vectors
    <base>.faiss       -> faiss index (if used)
- Query API: nearest_k(query_text, k) -> list of {id, meta, score}
- CLI: build index from text files, interactive query mode, save/load utilities.
- Defensive behavior and clear logging.
"""

from __future__ import annotations

import os
import json
import uuid
import logging
from pathlib import Path
from typing import List, Dict, Any, Optional, Tuple

import numpy as np

logger = logging.getLogger("indexer")
_log_level_name = os.getenv("LOG_LEVEL", "INFO").upper()
logger.setLevel(getattr(logging, _log_level_name, logging.INFO))
if not logger.handlers:
    ch = logging.StreamHandler()
    ch.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
    logger.addHandler(ch)

# attempt to import embedding module (required)
try:
    from . import embedding as embedding_module  # type: ignore
except Exception:
    embedding_module = None  # type: ignore

# attempt to import faiss (optional)
_faiss_available = False
try:
    import faiss  # type: ignore
    _faiss_available = True
except Exception:
    faiss = None  # type: ignore
    _faiss_available = False

# default index dir
DEFAULT_INDEX_DIR = Path(os.getenv("EMBEDDING_INDEX_DIR", "data/embeddings")).resolve()


# ----------------------
# Utilities
# ----------------------
def _ensure_parent(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)


def _cosine_sim_matrix(query_vec: np.ndarray, matrix: np.ndarray) -> np.ndarray:
    """
    Compute cosine similarity between query_vec (d,) and matrix (n,d) and return (n,) scores.
    Handles zero vectors robustly.
    """
    qn = np.linalg.norm(query_vec)
    mn = np.linalg.norm(matrix, axis=1)
    denom = qn * mn
    denom_safe = np.where(denom == 0, 1e-12, denom)
    sims = (matrix @ query_vec) / denom_safe
    # clip to [-1, 1] for numeric stability
    return np.clip(sims, -1.0, 1.0)


# ----------------------
# VectorIndex
# ----------------------
class VectorIndex:
    """
    Vector index for embeddings + metadata.

    Args:
      dim: optional embedding dimension (inferred from first embeddings if None)
      index_path: optional base path used when saving/loading
      use_faiss: prefer faiss backend when available
    """

    def __init__(self, dim: Optional[int] = None, index_path: Optional[Path] = None, use_faiss: bool = True):
        if embedding_module is None:
            raise RuntimeError("backend.embedding is required by indexer but not found")

        # discover embedding functions
        self._embed_single = None
        self._embed_batch = None

        # try common names for batch embedding functions
        for name in ("embed_batch", "generate_embeddings", "get_embeddings", "create_embeddings"):
            if hasattr(embedding_module, name):
                self._embed_batch = getattr(embedding_module, name)
                break

        # try common names for single embedding functions
        for name in ("embed", "generate_embedding", "get_embedding", "create_embedding"):
            if hasattr(embedding_module, name):
                self._embed_single = getattr(embedding_module, name)
                break

        # If no batch but single exists, wrap single
        if self._embed_batch is None and self._embed_single is not None:

            def _wrap_batch(texts: List[str]):
                return [self._embed_single(t) for t in texts]

            self._embed_batch = _wrap_batch

        if self._embed_batch is None:
            raise RuntimeError("embedding module must expose an embed or embed_batch function")

        self.dim = dim or getattr(embedding_module, "EMBEDDING_DIM", None)
        self.ids: List[str] = []
        self.meta: List[Dict[str, Any]] = []
        self.vectors: Optional[np.ndarray] = None  # (n, dim) float32 for numpy backend
        self.faiss_index = None
        self.index_path = Path(index_path) if index_path is not None else None
        # decide whether to use faiss
        self.use_faiss = bool(use_faiss) and _faiss_available
        if use_faiss and not _faiss_available:
            logger.warning("Faiss requested but not available. Falling back to numpy backend.")
            self.use_faiss = False

    # ----------------------
    # internal initializers
    # ----------------------
    def _init_vectors(self, dim: int) -> None:
        self.dim = int(dim)
        self.vectors = np.zeros((0, self.dim), dtype=np.float32)
        if self.use_faiss:
            # use inner product on normalized vectors to emulate cosine similarity
            try:
                self.faiss_index = faiss.IndexFlatIP(self.dim)
                logger.debug("Initialized faiss IndexFlatIP dim=%d", self.dim)
            except Exception:
                logger.exception("Failed to initialize faiss index; disabling faiss")
                self.use_faiss = False
                self.faiss_index = None

    def _add_vectors_inmemory(self, vecs: np.ndarray) -> None:
        if self.vectors is None:
            self._init_vectors(vecs.shape[1])
        if vecs.shape[1] != self.dim:
            raise ValueError("Embedding dimension mismatch")
        self.vectors = np.vstack([self.vectors, vecs.astype(np.float32)])

    def _add_vectors_faiss(self, vecs: np.ndarray) -> None:
        if self.faiss_index is None:
            if self.dim is None:
                self._init_vectors(vecs.shape[1])
            if self.faiss_index is None:
                self.faiss_index = faiss.IndexFlatIP(self.dim)
        # normalize rows to unit length
        norms = np.linalg.norm(vecs, axis=1, keepdims=True)
        norms = np.where(norms == 0, 1e-12, norms)
        normed = vecs / norms
        self.faiss_index.add(normed.astype(np.float32))

    # ----------------------
    # add / build
    # ----------------------
    def add(
        self,
        texts: List[str],
        metas: Optional[List[Dict[str, Any]]] = None,
        ids: Optional[List[str]] = None,
        chunking: Optional[int] = None,
    ) -> List[str]:
        """
        Embed and add a list of texts.

        - metas: optional metadata aligned to texts
        - ids: optional ids aligned to texts
        - chunking: if provided (n_chars) long docs are chunked into windows of ~n_chars with overlap (80%)
        Returns list of ids added.
        """
        if metas is None:
            metas = [{} for _ in texts]
        if ids is None:
            ids = [str(uuid.uuid4()) for _ in texts]

        expanded_texts: List[str] = []
        expanded_metas: List[Dict[str, Any]] = []
        expanded_ids: List[str] = []

        for i, txt in enumerate(texts):
            if chunking and len(txt) > chunking:
                step = max(1, int(chunking * 0.8))
                start = 0
                chunk_idx = 0
                while start < len(txt):
                    part = txt[start : start + chunking]
                    meta_copy = dict(metas[i]) if metas else {}
                    meta_copy["_chunk_index"] = chunk_idx
                    meta_copy["_source_id"] = ids[i]
                    expanded_texts.append(part)
                    expanded_metas.append(meta_copy)
                    expanded_ids.append(f"{ids[i]}_c{chunk_idx}")
                    chunk_idx += 1
                    start += step
            else:
                expanded_texts.append(txt)
                expanded_metas.append(metas[i])
                expanded_ids.append(ids[i])

        if not expanded_texts:
            return []

        # compute embeddings via batch function
        vecs = self._embed_batch(expanded_texts)
        vecs = np.asarray(vecs, dtype=np.float32)
        if vecs.ndim == 1:
            vecs = vecs.reshape(1, -1)

        if self.dim is None:
            self._init_vectors(vecs.shape[1])

        if vecs.shape[1] != self.dim:
            raise ValueError(f"Embedding dimension mismatch: index dim {self.dim} vs embeddings {vecs.shape[1]}")

        # add to backend
        if self.use_faiss:
            self._add_vectors_faiss(vecs)
            # keep a numpy copy for persistence if needed
            if self.vectors is None:
                self.vectors = vecs.astype(np.float32)
            else:
                self.vectors = np.vstack([self.vectors, vecs.astype(np.float32)])
        else:
            self._add_vectors_inmemory(vecs)

        # append metadata and ids
        self.ids.extend(expanded_ids)
        self.meta.extend(expanded_metas)

        logger.info("Added %d vectors to index (first ids: %s)", len(expanded_ids), expanded_ids[:3])
        return expanded_ids

    # ----------------------
    # persistence
    # ----------------------
    def save(self, base_path: Optional[Path] = None) -> Path:
        """
        Persist index to disk and return base path (Path without extension).
        """
        base = Path(base_path or self.index_path or (DEFAULT_INDEX_DIR / f"index-{uuid.uuid4().hex}"))
        base = base.with_suffix("")  # ensure no suffix
        _ensure_parent(base)

        meta_path = base.with_name(base.name + "_meta.json")
        ids_path = base.with_name(base.name + "_ids.json")
        npy_path = base.with_name(base.name + ".npy")
        faiss_path = base.with_name(base.name + ".faiss")

        with open(meta_path, "w", encoding="utf-8") as fh:
            json.dump(self.meta, fh, ensure_ascii=False, indent=2)
        with open(ids_path, "w", encoding="utf-8") as fh:
            json.dump(self.ids, fh, ensure_ascii=False, indent=2)

        if self.use_faiss and self.faiss_index is not None:
            try:
                faiss.write_index(self.faiss_index, str(faiss_path))
                logger.info("Saved faiss index to %s", faiss_path)
            except Exception:
                logger.exception("Failed to save faiss index; falling back to numpy array")
                if self.vectors is not None:
                    np.save(str(npy_path), self.vectors)
                    logger.info("Saved numpy vectors to %s", npy_path)
        else:
            if self.vectors is not None:
                np.save(str(npy_path), self.vectors)
                logger.info("Saved numpy vectors to %s", npy_path)

        logger.info("Saved metadata %s and ids %s", meta_path, ids_path)
        return base

    @classmethod
    def load(cls, base_path: Path, use_faiss: Optional[bool] = None) -> "VectorIndex":
        """
        Load a persisted index from base_path (base without extension).
        If faiss file present and faiss available, it will prefer faiss when use_faiss is True.
        """
        base = Path(base_path).with_suffix("")
        meta_path = base.with_name(base.name + "_meta.json")
        ids_path = base.with_name(base.name + "_ids.json")
        npy_path = base.with_name(base.name + ".npy")
        faiss_path = base.with_name(base.name + ".faiss")

        if not meta_path.exists() or not ids_path.exists():
            raise FileNotFoundError(f"Index metadata or ids not found at base {base}")

        with open(meta_path, "r", encoding="utf-8") as fh:
            meta = json.load(fh)
        with open(ids_path, "r", encoding="utf-8") as fh:
            ids = json.load(fh)

        prefer_faiss = (use_faiss if use_faiss is not None else True) and _faiss_available and faiss_path.exists()

        vi = cls(dim=None, index_path=base, use_faiss=prefer_faiss)
        vi.meta = meta
        vi.ids = ids

        if prefer_faiss:
            try:
                vi.faiss_index = faiss.read_index(str(faiss_path))
                # faiss IndexFlatIP has attribute d for dimension in many builds
                try:
                    vi.dim = int(vi.faiss_index.d)
                except Exception:
                    # fallback: infer from stored numpy vectors if present
                    vi.dim = None
                logger.info("Loaded faiss index from %s (dim=%s)", faiss_path, vi.dim)
                return vi
            except Exception:
                logger.exception("Failed to load faiss index; will try numpy")

        if npy_path.exists():
            vecs = np.load(str(npy_path))
            vi.vectors = vecs.astype(np.float32)
            vi.dim = vi.vectors.shape[1]
            logger.info("Loaded numpy vectors from %s (n=%d, dim=%d)", npy_path, vi.vectors.shape[0], vi.dim)
            return vi

        raise RuntimeError(f"No usable vector artifact found for index at {base}")

    # ----------------------
    # querying
    # ----------------------
    def nearest_k(self, query: str, k: int = 5) -> List[Dict[str, Any]]:
        """
        Return top-k nearest neighbors for query text.
        Each result: {"id":..., "meta":..., "score": ...} where score is cosine similarity in [-1,1].
        """
        if self._embed_single is None and self._embed_batch is None:
            raise RuntimeError("No embedding function available")

        # embed query
        if self._embed_single is not None:
            qvec = np.asarray(self._embed_single(query), dtype=np.float32)
        else:
            qvec = np.asarray(self._embed_batch([query])[0], dtype=np.float32)

        if qvec.ndim != 1:
            qvec = qvec.reshape(-1)

        if self.dim is None:
            # bootstrap dim from query
            self.dim = int(qvec.shape[0])
            if not self.use_faiss and self.vectors is None:
                self.vectors = np.zeros((0, self.dim), dtype=np.float32)

        if qvec.shape[0] != self.dim:
            raise ValueError("Query embedding dim mismatch")

        results: List[Tuple[int, float]] = []

        if self.use_faiss and self.faiss_index is not None:
            # normalize query
            qn = np.linalg.norm(qvec)
            qn = 1e-12 if qn == 0 else qn
            qnorm = (qvec / qn).astype(np.float32)
            try:
                D, I = self.faiss_index.search(np.expand_dims(qnorm, axis=0), k)
                idxs = I[0].tolist()
                scores = D[0].tolist()
                for idx, sc in zip(idxs, scores):
                    if idx < 0 or idx >= len(self.ids):
                        continue
                    results.append((int(idx), float(sc)))
            except Exception:
                logger.exception("Faiss search failed; falling back to numpy scan")
                # fallback to numpy below
                if self.vectors is not None and self.vectors.shape[0] > 0:
                    sims = _cosine_sim_matrix(qvec, self.vectors)
                    top_idx = np.argsort(-sims)[:k]
                    for idx in top_idx.tolist():
                        results.append((int(idx), float(sims[idx])))
        else:
            if self.vectors is None or self.vectors.shape[0] == 0:
                return []
            sims = _cosine_sim_matrix(qvec, self.vectors)
            top_idx = np.argsort(-sims)[:k]
            for idx in top_idx.tolist():
                results.append((int(idx), float(sims[idx])))

        out: List[Dict[str, Any]] = []
        for idx, score in results:
            out.append(
                {
                    "id": self.ids[idx] if idx < len(self.ids) else None,
                    "meta": self.meta[idx] if idx < len(self.meta) else {},
                    "score": float(score),
                }
            )
        return out


# ----------------------
# Convenience functions / CLI helpers
# ----------------------
def build_index_from_text_files(
    paths: List[Path], index_base: Optional[Path] = None, chunk_chars: Optional[int] = 2000, use_faiss: bool = True
) -> VectorIndex:
    """
    Build an index from a list of text files, persist and return the VectorIndex.
    """
    texts: List[str] = []
    metas: List[Dict[str, Any]] = []
    ids: List[str] = []

    for p in paths:
        if not p.exists():
            logger.warning("Skipping missing file %s", p)
            continue
        text = p.read_text(encoding="utf-8")
        texts.append(text)
        metas.append({"source": str(p), "name": p.name})
        ids.append(str(uuid.uuid4()))

    if not texts:
        raise RuntimeError("No input texts to index")

    idx = VectorIndex(dim=None, index_path=index_base, use_faiss=use_faiss)
    idx.add(texts, metas=metas, ids=ids, chunking=chunk_chars)
    saved = idx.save(index_base or (DEFAULT_INDEX_DIR / f"index-{uuid.uuid4().hex}"))
    logger.info("Index built and saved to %s", saved)
    return idx


def simple_query_loop(index: VectorIndex, top_k: int = 5) -> None:
    print("Interactive query loop (type exit/quit to stop)")
    while True:
        try:
            query = input("query> ").strip()
        except (KeyboardInterrupt, EOFError):
            print()
            break
        if not query or query.lower() in ("exit", "quit"):
            break
        try:
            results = index.nearest_k(query, k=top_k)
            for r in results:
                print(f"{r['score']:.4f}\t{r['id']}\t{r.get('meta', {})}")
        except Exception as e:
            print("Error:", e)


# ----------------------
# CLI
# ----------------------
def _cli():
    import argparse

    parser = argparse.ArgumentParser(description="Index builder / query tool")
    sub = parser.add_subparsers(dest="cmd", required=True)

    build = sub.add_parser("build", help="Build index from text files")
    build.add_argument("--inputs", nargs="+", required=True, help="Text file paths")
    build.add_argument("--out", default=str(DEFAULT_INDEX_DIR / "index"), help="Base path to save index")
    build.add_argument("--chunk-chars", type=int, default=2000, help="Chunk size (chars) for long docs")
    build.add_argument("--use-faiss", action="store_true", help="Use faiss backend if available")

    query = sub.add_parser("query", help="Query existing index")
    query.add_argument("--base", required=True, help="Base path used when index was saved")
    query.add_argument("--k", type=int, default=5, help="Top-k results to return")

    args = parser.parse_args()

    if args.cmd == "build":
        paths = [Path(p) for p in args.inputs]
        build_index_from_text_files(paths, index_base=Path(args.out), chunk_chars=args.chunk_chars, use_faiss=args.use_faiss)
    elif args.cmd == "query":
        vi = VectorIndex.load(Path(args.base))
        simple_query_loop(vi, top_k=args.k)


if __name__ == "__main__":
    _cli()
