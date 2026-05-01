"""Content-hashed local LLM response cache (W9.4).

Anthropic's server-side prompt cache (1h TTL via ``cache_control:
ephemeral``) is what makes the cloud path cheap. Local providers
(ollama / vllm / llama.cpp) have their own prefix caching but it's
in-process — restart the server and you start over. This module
adds a *response-level* cache that survives server restarts,
keyed by the SHA-256 of the request:

    sha256(provider | model | system | json(messages))

Stored under ``~/.claudestruct/llm_cache/<sha[:2]>/<sha>.json``.
The two-level shard keeps directory listings small even when the
cache balloons.

Use cases this hits:

- **dry-run iteration**: same prompt re-evaluated against the same
  local model returns instantly.
- **regression replay**: when fine-tuning the local model, you can
  replay the exact prior request to compare quality with no API
  cost.
- **demos / docs**: a recorded run can be replayed deterministically.

This is **opt-in** via ``--llm-cache`` flag or
``CLAUDESTRUCT_LLM_CACHE=1`` env. Default off so cloud-Anthropic
users (the primary path today) don't accidentally serve stale
responses.

Cache miss is silent. Cache hit emits a ``cache.local.hit`` event
through the existing structured-logging surface so ``cs dashboard``
can surface hit-rate alongside the existing Anthropic cache numbers.
"""
from __future__ import annotations

import hashlib
import json
import os
import time
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

# --- Cache key ------------------------------------------------------


def _canonical_messages(messages: list[dict[str, Any]] | tuple) -> str:
    """Produce a stable JSON serialisation of the messages list.

    Two requests with identical content but different dict-iteration
    order must produce the same key. ``sort_keys=True`` + tuple-of-
    primitives normalisation handles that.
    """
    return json.dumps(list(messages), sort_keys=True, separators=(",", ":"))


def cache_key(
    *,
    provider: str,
    model: str,
    system: str,
    messages: list[dict[str, Any]] | tuple,
) -> str:
    """SHA-256 of the request shape. Stable across runs.

    ``system`` and ``messages`` are the only request-content fields
    that affect the response; sampling params (temperature, top-p)
    intentionally aren't keyed because callers usually want the same
    response back for repeated dry-runs even with slightly different
    sampling. Adjust if a downstream needs strict-mode caching.
    """
    h = hashlib.sha256()
    h.update(provider.encode("utf-8"))
    h.update(b"\x00")
    h.update(model.encode("utf-8"))
    h.update(b"\x00")
    h.update(system.encode("utf-8"))
    h.update(b"\x00")
    h.update(_canonical_messages(messages).encode("utf-8"))
    return h.hexdigest()


# --- Cache entry schema --------------------------------------------


@dataclass(frozen=True)
class CachedResponse:
    """What a cache hit returns to the caller. Mirrors the subset of
    `client.LLMResult` the user-visible code actually reads."""
    text: str
    input_tokens: int
    output_tokens: int
    cache_read_tokens: int
    cache_creation_tokens: int
    # When the cache was written (unix epoch seconds). Lets the
    # consumer warn "this cached response is N days old".
    created_at: float


# --- Storage --------------------------------------------------------


def _default_cache_root() -> Path:
    """``~/.claudestruct/llm_cache/``. Override via
    ``CLAUDESTRUCT_LLM_CACHE_DIR``."""
    explicit = os.environ.get("CLAUDESTRUCT_LLM_CACHE_DIR", "").strip()
    if explicit:
        return Path(explicit).expanduser()
    return Path.home() / ".claudestruct" / "llm_cache"


def _path_for(key: str, *, root: Path) -> Path:
    """Two-level shard: ``<root>/<aa>/<full-key>.json``. Keeps
    directory listings small even at 1M entries."""
    if len(key) < 2:
        # Defensive: a malformed key still maps to a valid path.
        shard = "_"
    else:
        shard = key[:2]
    return root / shard / f"{key}.json"


def is_enabled() -> bool:
    """Cache is opt-in. Enabled when ``CLAUDESTRUCT_LLM_CACHE`` is
    set to a truthy value (``1`` / ``true`` / ``yes``). The CLI
    ``--llm-cache`` flag exports the env so the runner sees it."""
    v = os.environ.get("CLAUDESTRUCT_LLM_CACHE", "").strip().lower()
    return v in {"1", "true", "yes", "on"}


def get(
    key: str,
    *,
    root: Path | None = None,
) -> CachedResponse | None:
    """Look up a cached response. Returns ``None`` on miss / read
    error — corruption is treated as miss so a single bad file
    doesn't poison the whole cache."""
    p = _path_for(key, root=root or _default_cache_root())
    if not p.exists():
        return None
    try:
        raw = json.loads(p.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    try:
        return CachedResponse(
            text=str(raw["text"]),
            input_tokens=int(raw.get("input_tokens", 0)),
            output_tokens=int(raw.get("output_tokens", 0)),
            cache_read_tokens=int(raw.get("cache_read_tokens", 0)),
            cache_creation_tokens=int(raw.get("cache_creation_tokens", 0)),
            created_at=float(raw.get("created_at", 0.0)),
        )
    except (KeyError, TypeError, ValueError):
        return None


def put(
    key: str,
    value: CachedResponse,
    *,
    root: Path | None = None,
) -> None:
    """Persist a response under the given key. Writes atomically
    (write-tmp-then-rename) so a crash mid-write doesn't leave a
    half-written file at the canonical path."""
    p = _path_for(key, root=root or _default_cache_root())
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(p.suffix + ".tmp")
    tmp.write_text(
        json.dumps(asdict(value), separators=(",", ":")),
        encoding="utf-8",
    )
    tmp.replace(p)


def now() -> float:
    """Wall-clock used for ``created_at``. Hoisted so tests can
    monkeypatch."""
    return time.time()


# --- Stats ----------------------------------------------------------


@dataclass(frozen=True)
class CacheStats:
    entries: int
    bytes: int


def stats(*, root: Path | None = None) -> CacheStats:
    """Walk the cache dir and report entry count + total bytes.

    Used by ``cs dashboard`` (future) to show cache size next to the
    Anthropic-side hit numbers. O(N) on the cache size; for a fresh
    deployment N is small enough that scanning is fine.
    """
    r = root or _default_cache_root()
    if not r.exists():
        return CacheStats(entries=0, bytes=0)
    n = 0
    total = 0
    for shard in r.iterdir():
        if not shard.is_dir():
            continue
        for f in shard.iterdir():
            if not f.name.endswith(".json"):
                continue
            try:
                total += f.stat().st_size
                n += 1
            except OSError:
                # Race: file vanished between iterdir and stat. Skip.
                continue
    return CacheStats(entries=n, bytes=total)


def clear(*, root: Path | None = None) -> int:
    """Delete every cached response. Returns the number deleted.

    Tests use this between cases. Operators may also want it after
    a model upgrade where stale responses no longer reflect the
    new model's output.
    """
    r = root or _default_cache_root()
    if not r.exists():
        return 0
    deleted = 0
    for shard in r.iterdir():
        if not shard.is_dir():
            continue
        for f in shard.iterdir():
            if not f.name.endswith(".json"):
                continue
            try:
                f.unlink()
                deleted += 1
            except OSError:
                continue
    return deleted
