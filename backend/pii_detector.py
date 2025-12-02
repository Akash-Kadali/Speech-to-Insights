"""
backend/pii_detector.py

Upgraded, non-degraded PII detector for speech_to_insights.

Features / improvements over prior version:
- Same conservative regex coverage for EMAIL, PHONE, SSN, CREDIT_CARD, IP, URL, etc.
- Better merging strategy: prefer higher-score and longer matches when resolving overlaps.
- Optional AWS Comprehend integration (controlled by AWS_COMPREHEND_ENABLED).
- Optional spaCy NER integration (if spaCy + model available).
- Extra utilities:
    - detect_pii(text: str) -> dict
    - redact_pii(text: str, replace_with="[REDACTED]", preserve_last_n: dict = None) -> (str, dict)
      preserve_last_n: optional map of entity type -> int to keep last N characters (useful for credit cards).
    - detect_pii_batch(texts: List[str]) -> List[dict]
- Clear, auditable reports with spans, source, and conservative confidence estimates.
- Defensive: falls back to regex + spaCy when Comprehend fails; no network calls unless enabled.
"""

from __future__ import annotations

import os
import re
import json
import logging
from typing import List, Dict, Any, Tuple, Optional, Iterable

logger = logging.getLogger("pii_detector")
_log_level_name = os.getenv("LOG_LEVEL", "INFO").upper()
logger.setLevel(getattr(logging, _log_level_name, logging.INFO))

# Optional externals
try:
    import boto3  # type: ignore
    from botocore.exceptions import BotoCoreError, ClientError  # type: ignore
    _boto3_available = True
except Exception:
    boto3 = None  # type: ignore
    _boto3_available = False

try:
    import spacy  # type: ignore
    _spacy_available = True
except Exception:
    spacy = None  # type: ignore
    _spacy_available = False

# Config
AWS_COMPREHEND_ENABLED = os.getenv("AWS_COMPREHEND_ENABLED", "false").lower() == "true"
AWS_REGION = os.getenv("AWS_REGION", None)

# Attempt to load a spaCy model if available (optional)
_spacy_nlp = None
if _spacy_available:
    try:
        for mdl in ("en_core_web_sm", "en_core_web_md", "en_core_web_trf"):
            try:
                _spacy_nlp = spacy.load(mdl)
                logger.info("spaCy model %s loaded for NER", mdl)
                break
            except Exception:
                continue
        if _spacy_nlp is None:
            logger.info("No spaCy English model found; spaCy NER disabled")
            _spacy_available = False
    except Exception:
        logger.exception("Failed to initialize spaCy; disabling")
        _spacy_available = False

# --- Patterns ---------------------------------------------------------------
# Conservative regex list. Each item: (label, compiled_re, confidence_estimate)
_REGEX_PATTERNS: List[Tuple[str, re.Pattern, float]] = [
    ("EMAIL", re.compile(r"[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+"), 0.95),
    # phone-ish (permissive)
    ("PHONE", re.compile(r"(?:\+?\d{1,3}[-.\s]?)?(?:\(?\d{2,4}\)?[-.\s]?)?\d{3,4}[-.\s]?\d{3,4}"), 0.70),
    ("SSN", re.compile(r"\b\d{3}-\d{2}-\d{4}\b"), 0.98),
    # credit-card like (very permissive — redact carefully)
    ("CREDIT_CARD", re.compile(r"\b(?:\d[ -]*?){13,19}\b"), 0.60),
    ("IP_ADDRESS", re.compile(r"\b(?:\d{1,3}\.){3}\d{1,3}\b"), 0.90),
    ("URL", re.compile(r"https?://[^\s]+|www\.[^\s]+"), 0.90),
    # Very permissive driver license-ish pattern (low confidence)
    ("US_DRIVER_LICENSE", re.compile(r"\b[A-Z]{1,2}\d{4,8}\b"), 0.35),
]

_DEFAULT_REPLACEMENT = "[REDACTED]"

# Lazy AWS Comprehend client
def _get_comprehend_client():
    if not _boto3_available:
        raise RuntimeError("boto3 not available in this environment")
    if AWS_REGION:
        return boto3.client("comprehend", region_name=AWS_REGION)
    return boto3.client("comprehend")


# --- AWS Comprehend helper --------------------------------------------------
def _comprehend_detect_pii(text: str) -> List[Dict[str, Any]]:
    if not AWS_COMPREHEND_ENABLED:
        raise RuntimeError("Comprehend not enabled")
    if not _boto3_available:
        raise RuntimeError("boto3 not available")

    client = _get_comprehend_client()
    try:
        resp = client.detect_pii_entities(Text=text, LanguageCode="en")
        entities = resp.get("Entities", []) or []
        out: List[Dict[str, Any]] = []
        for e in entities:
            begin = int(e.get("BeginOffset", 0))
            end = int(e.get("EndOffset", 0))
            out.append({
                "type": e.get("Type"),
                "score": float(e.get("Score", 0.0)),
                "start": begin,
                "end": end,
                "text": text[begin:end],
                "source": "comprehend"
            })
        return out
    except (BotoCoreError, ClientError) as exc:
        logger.exception("Comprehend detect_pii_entities failed: %s", exc)
        raise RuntimeError(f"Comprehend error: {exc}") from exc


# --- spaCy helper ----------------------------------------------------------
def _spacy_detect_pii(text: str) -> List[Dict[str, Any]]:
    if not _spacy_available or _spacy_nlp is None:
        return []
    try:
        doc = _spacy_nlp(text)
    except Exception:
        logger.exception("spaCy model failed to process text")
        return []

    out: List[Dict[str, Any]] = []
    for ent in doc.ents:
        mapped_type = ent.label_
        # map common labels conservatively
        if ent.label_ == "PERSON":
            mapped_type = "PERSON"
        elif ent.label_ in ("GPE", "LOC"):
            mapped_type = "LOCATION"
        elif ent.label_ == "ORG":
            mapped_type = "ORG"
        elif ent.label_ in ("MONEY",):
            mapped_type = "MONEY"
        out.append({
            "type": mapped_type,
            "score": 0.60,
            "start": ent.start_char,
            "end": ent.end_char,
            "text": ent.text,
            "source": "spacy"
        })
    return out


# --- Regex detector --------------------------------------------------------
def _regex_detect(text: str) -> List[Dict[str, Any]]:
    entities: List[Dict[str, Any]] = []
    for label, pattern, confidence in _REGEX_PATTERNS:
        for m in pattern.finditer(text):
            s, e = m.start(), m.end()
            # sanity: ignore zero-length
            if e <= s:
                continue
            entities.append({
                "type": label,
                "score": float(confidence),
                "start": int(s),
                "end": int(e),
                "text": m.group(0),
                "source": "regex"
            })
    return entities


# --- Merge strategy --------------------------------------------------------
def _merge_entities(primary: Iterable[Dict[str, Any]], secondary: Iterable[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """
    Merge two lists of entities. Keep non-overlapping entities, prefer higher score then longer span.
    Returns accepted entities sorted by start.
    """
    candidates = list(primary) + list(secondary)
    # Normalize numeric fields
    for c in candidates:
        c.setdefault("score", 0.0)
        c.setdefault("start", int(c.get("start", 0)))
        c.setdefault("end", int(c.get("end", 0)))

    # Sort: score desc, span length desc (prefer longer more informative), start asc
    candidates.sort(key=lambda x: (-float(x.get("score", 0.0)), -(x["end"] - x["start"]), x["start"]))

    accepted: List[Dict[str, Any]] = []
    occupied: List[Tuple[int, int]] = []

    for ent in candidates:
        s, e = ent["start"], ent["end"]
        if s >= e:
            continue
        overlap = False
        for os, oe in occupied:
            # overlap if ranges intersect
            if not (e <= os or s >= oe):
                overlap = True
                break
        if not overlap:
            accepted.append(ent)
            occupied.append((s, e))

    # Return sorted by start for readability
    accepted.sort(key=lambda x: x["start"])
    return accepted


# --- API: detection --------------------------------------------------------
def detect_pii(text: str) -> Dict[str, Any]:
    """
    Detect PII in text and return an audit-friendly report.
    """
    if not isinstance(text, str):
        raise TypeError("text must be str")

    regex_entities = _regex_detect(text)

    comprehend_entities: List[Dict[str, Any]] = []
    if AWS_COMPREHEND_ENABLED:
        try:
            comprehend_entities = _comprehend_detect_pii(text)
        except Exception:
            logger.exception("Comprehend detection failed; falling back to local")

    spacy_entities: List[Dict[str, Any]] = []
    if _spacy_available:
        try:
            spacy_entities = _spacy_detect_pii(text)
        except Exception:
            logger.exception("spaCy detection failed; continuing")

    # Merge: regex first then cloud/ner results (merge routine prefers higher-scoring, longer spans)
    merged = _merge_entities(regex_entities, comprehend_entities + spacy_entities)

    counts: Dict[str, int] = {}
    for e in merged:
        counts[e["type"]] = counts.get(e["type"], 0) + 1

    return {
        "text": text,
        "length": len(text),
        "entities": merged,
        "summary": {"counts": counts, "total": len(merged)}
    }


def detect_pii_batch(texts: Iterable[str]) -> List[Dict[str, Any]]:
    """Batch variant returning per-text reports."""
    return [detect_pii(t) for t in texts]


# --- Redaction -------------------------------------------------------------
def _mask_keep_last(fragment: str, keep_last: int, replace_with: str) -> str:
    """
    Replace all but the last keep_last characters with replace_with (single token).
    If keep_last <= 0 returns replace_with.
    If fragment shorter than keep_last, return replace_with + fragment (so some context is preserved).
    """
    if keep_last <= 0:
        return replace_with
    # If fragment shorter than keep_last, keep the fragment but still prefix with replace token
    if len(fragment) <= keep_last:
        return replace_with + fragment
    return replace_with + fragment[-keep_last:]


def _redact_spanwise(text: str, entities: List[Dict[str, Any]], replace_with: str = _DEFAULT_REPLACEMENT,
                     preserve_last_n: Optional[Dict[str, int]] = None) -> str:
    """
    Redact entity spans in text. preserve_last_n can specify per-entity-type ints to keep last N chars.
    Entities assumed non-overlapping and sorted by start (but function will sort to be safe).
    """
    if not entities:
        return text

    preserve_last_n = preserve_last_n or {}
    pieces: List[str] = []
    last = 0
    for ent in sorted(entities, key=lambda x: int(x["start"])):
        s = max(int(ent["start"]), last)
        e = int(ent["end"])
        if s >= e:
            continue
        pieces.append(text[last:s])
        fragment = text[s:e]
        keep_n = preserve_last_n.get(ent.get("type", ""), 0)
        if keep_n:
            pieces.append(_mask_keep_last(fragment, keep_n, replace_with))
        else:
            pieces.append(replace_with)
        last = e
    pieces.append(text[last:])
    return "".join(pieces)


def redact_pii(text: str, replace_with: str = _DEFAULT_REPLACEMENT,
               preserve_last_n: Optional[Dict[str, int]] = None) -> Tuple[str, Dict[str, Any]]:
    """
    Detect and redact PII. preserve_last_n example: {"CREDIT_CARD": 4} to show last 4 digits.
    Returns (redacted_text, report).
    """
    report = detect_pii(text)
    redacted = _redact_spanwise(text, report["entities"], replace_with=replace_with, preserve_last_n=preserve_last_n)
    return redacted, report


# --- CLI -------------------------------------------------------------------
def _cli():
    import argparse
    parser = argparse.ArgumentParser(description="PII detector / redactor (local).")
    parser.add_argument("input", nargs="?", help="Input text file or '-' for stdin (default stdin).")
    parser.add_argument("--redact", action="store_true", help="Print redacted text as well.")
    parser.add_argument("--replace", default=_DEFAULT_REPLACEMENT, help="Replacement token for redaction.")
    parser.add_argument("--keep-last-cc", type=int, default=0, help="Preserve last N digits for CREDIT_CARD.")
    args = parser.parse_args()

    if not args.input or args.input == "-":
        import sys
        text = sys.stdin.read()
    else:
        with open(args.input, "r", encoding="utf-8") as fh:
            text = fh.read()

    report = detect_pii(text)
    print(json.dumps(report, indent=2))
    if args.redact:
        preserve = {"CREDIT_CARD": args.keep_last_cc} if args.keep_last_cc > 0 else {}
        redacted, _ = redact_pii(text, replace_with=args.replace, preserve_last_n=preserve)
        print("\n--- REDACTED ---\n")
        print(redacted)


# Exports
__all__ = ["detect_pii", "redact_pii", "detect_pii_batch"]

if __name__ == "__main__":
    _cli()
