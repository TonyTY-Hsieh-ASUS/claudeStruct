"""Persists per-(task, model) cache write timestamps so we can detect a
silent cache invalidation across CLI invocations.

The CLI is one-shot — every `cs dev ...` is a fresh process — so a single
in-memory counter (like claw-squad's `isSilentCacheInvalidator`) won't
work. Instead we drop a small JSON file under `~/.claudestruct/` keyed by
(task, model, prompt_hash). When the next call comes in within the cache
TTL with the *same* prompt hash but reports zero `cache_read_input_tokens`,
something is invalidating the prefix and we surface a warning.

Different prompt hash → expected miss → no warning.
"""
from __future__ import annotations

import hashlib
import json
import os
import time
from dataclasses import dataclass
from pathlib import Path

# Anthropic ephemeral cache TTL is 1h; warn if a miss happens within 50 min
# of a successful write — the 10-minute buffer absorbs clock skew and
# borderline-expired entries.
CACHE_TTL_SECONDS = 50 * 60

_STATE_VERSION = 1


def _state_dir() -> Path:
    override = os.environ.get("CLAUDESTRUCT_HOME")
    if override:
        return Path(override).expanduser()
    return Path.home() / ".claudestruct"


def _state_path() -> Path:
    return _state_dir() / "cache_state.json"


def prompt_hash(prompt_text: str) -> str:
    return hashlib.sha256(prompt_text.encode("utf-8")).hexdigest()[:16]


@dataclass
class CacheEntry:
    written_at: float
    prompt_hash: str


def _load() -> dict[str, CacheEntry]:
    path = _state_path()
    if not path.exists():
        return {}
    try:
        raw = json.loads(path.read_text())
    except (json.JSONDecodeError, OSError):
        return {}
    if raw.get("version") != _STATE_VERSION:
        return {}
    out: dict[str, CacheEntry] = {}
    for key, val in raw.get("entries", {}).items():
        try:
            out[key] = CacheEntry(
                written_at=float(val["written_at"]),
                prompt_hash=str(val["prompt_hash"]),
            )
        except (KeyError, TypeError, ValueError):
            continue
    return out


def _save(entries: dict[str, CacheEntry]) -> None:
    path = _state_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "version": _STATE_VERSION,
        "entries": {
            k: {"written_at": v.written_at, "prompt_hash": v.prompt_hash}
            for k, v in entries.items()
        },
    }
    # Best-effort atomic write — readers tolerate missing/garbled state.
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(payload))
    tmp.replace(path)


def _key(task: str, model: str) -> str:
    return f"{task}|{model}"


def check_for_silent_miss(
    task: str,
    model: str,
    current_prompt_hash: str,
    cache_read_tokens: int,
    now: float | None = None,
) -> str | None:
    """Return a warning string if a silent cache miss is suspected.

    Conditions: previous successful write exists for the same (task, model,
    prompt_hash) within CACHE_TTL_SECONDS, and this call returned zero cache
    reads.
    """
    if cache_read_tokens > 0:
        return None
    entries = _load()
    prev = entries.get(_key(task, model))
    if prev is None:
        return None
    if prev.prompt_hash != current_prompt_hash:
        return None
    elapsed = (now if now is not None else time.time()) - prev.written_at
    if elapsed < 0 or elapsed > CACHE_TTL_SECONDS:
        return None
    minutes = max(1, int(elapsed // 60))
    return (
        f"cache miss: a write for ({task}, {model}) landed {minutes} min ago "
        f"with the same prompt hash, but this call read 0 cached tokens. "
        f"Something between calls is invalidating the prefix."
    )


def record_cache_write(
    task: str,
    model: str,
    current_prompt_hash: str,
    cache_creation_tokens: int,
    cache_read_tokens: int,
    now: float | None = None,
) -> None:
    """Record this call so the next one can compare. We treat any call that
    either wrote to or read from the cache as a successful warm state."""
    if cache_creation_tokens == 0 and cache_read_tokens == 0:
        return
    entries = _load()
    entries[_key(task, model)] = CacheEntry(
        written_at=now if now is not None else time.time(),
        prompt_hash=current_prompt_hash,
    )
    try:
        _save(entries)
    except OSError:
        # Persisting is best-effort — never break the user's run on it.
        pass
