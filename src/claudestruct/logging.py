"""Structured event log for claudestruct.

The CLI's Rich console output is tuned for human reading; it's not
machine-parseable, doesn't survive pipes intact, and can't be aggregated
across runs without screen-scraping. This module is the second sink:
when a user passes `--log-json <path>`, every interesting event lands
there as a single JSON line.

The schema is intentionally narrow — `run.start`, `agent.usage`,
`cache.warning`, `run.end` — covering the same data points the CLI
already prints. Downstream tooling (the planned `cs dashboard`, OTel
exporter, simple `jq` pipelines) can read this without depending on the
internal Rich layout.

Events shape is deliberately compatible with claw-squad's run log
(see `claw-squad/src/runs/log.ts`) so a mixed Python/TS deployment can
be aggregated by a single consumer.
"""
from __future__ import annotations

import json
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import IO, Any


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


@dataclass
class EventSink:
    """Append-only JSON-lines writer.

    Best-effort: a write failure is swallowed (logged via stderr by the
    caller's exception handler if needed) so an observability blip
    never breaks the user's actual run.

    Optional ``redactor`` applies PII / secret stripping before each
    write. None == no-op (back-compat). See ``redact.Redactor``.
    """

    path: Path
    _fh: IO[str] | None = None
    redactor: Any = None  # claudestruct.redact.Redactor | None

    def open(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._fh = self.path.open("a", encoding="utf-8")

    def write(self, event: dict[str, Any]) -> None:
        if self._fh is None:
            return
        payload = self.redactor.redact(event) if self.redactor is not None else event
        try:
            self._fh.write(json.dumps(payload, separators=(",", ":")) + "\n")
            self._fh.flush()
        except OSError:
            pass

    def close(self) -> None:
        if self._fh is not None:
            try:
                self._fh.close()
            except OSError:
                pass
            self._fh = None


class NullSink:
    """No-op sink for runs without `--log-json`."""

    def open(self) -> None: ...
    def write(self, event: dict[str, Any]) -> None: ...
    def close(self) -> None: ...


class MultiSink:
    """Fan-out sink: every event lands at every wrapped sink. Used by
    the CLI to write both the auto-emitted dashboard log and an
    optional user-supplied `--log-json` path in one pass."""

    def __init__(self, sinks: list[EventSink | NullSink]):
        self._sinks = sinks

    def open(self) -> None:
        for s in self._sinks:
            s.open()

    def write(self, event: dict[str, Any]) -> None:
        for s in self._sinks:
            s.write(event)

    def close(self) -> None:
        for s in self._sinks:
            s.close()


def make_sink(path: str | None, redactor: Any = None) -> EventSink | NullSink:
    if not path:
        return NullSink()
    return EventSink(path=Path(path).expanduser(), redactor=redactor)


@contextmanager
def event_log(
    path: str | None,
    redactor: Any = None,
) -> Iterator[EventSink | NullSink]:
    sink = make_sink(path, redactor=redactor)
    sink.open()
    try:
        yield sink
    finally:
        sink.close()


@contextmanager
def fanout_log(
    paths: list[str | None],
    redactor: Any = None,
) -> Iterator[MultiSink]:
    """Open multiple JSONL sinks at once. Empty/None entries are
    silently dropped. Useful when the CLI writes both the auto-log
    and a user-supplied --log-json target.

    ``redactor`` is shared across all sinks — applied once per write
    to minimize regex cost when fanning out."""
    sinks = [make_sink(p, redactor=redactor) for p in paths]
    multi = MultiSink(sinks)
    multi.open()
    try:
        yield multi
    finally:
        multi.close()


# ---- Event constructors ---------------------------------------------
#
# Plain dicts, not classes. We want JSON serialization to be free; we
# don't want a type lattice that has to migrate every time we add a
# field. Consumers should treat unknown fields as additive.


def run_start(
    *,
    task: str,
    model: str,
    effort: str | None,
    prompt_version: str | None,
) -> dict[str, Any]:
    return {
        "ts": _now_iso(),
        "type": "run.start",
        "tool": "claudestruct",
        "task": task,
        "model": model,
        "effort": effort,
        "promptVersion": prompt_version,
    }


def agent_usage(
    *,
    role: str,
    provider: str,
    model: str,
    input_tokens: int,
    output_tokens: int,
    cache_read_tokens: int,
    cache_creation_tokens: int,
    cost_usd: float,
) -> dict[str, Any]:
    return {
        "ts": _now_iso(),
        "type": "agent.usage",
        "role": role,
        "provider": provider,
        "model": model,
        "inputTokens": input_tokens,
        "outputTokens": output_tokens,
        "cacheReadTokens": cache_read_tokens,
        "cacheCreationTokens": cache_creation_tokens,
        "costUsd": cost_usd,
    }


def cache_warning(message: str) -> dict[str, Any]:
    return {
        "ts": _now_iso(),
        "type": "cache.warning",
        "message": message,
    }


def run_end(
    *,
    reason: str,
    duration_ms: int,
    total_cost_usd: float,
) -> dict[str, Any]:
    return {
        "ts": _now_iso(),
        "type": "run.end",
        "reason": reason,
        "durationMs": duration_ms,
        "totalCostUsd": total_cost_usd,
    }


# W10.6 — opt-in IO capture for fine-tuning datasets. Off by default
# because logging the raw prompt + response can leak source code, PII,
# and credentials into the run-log directory. Enable via
# CLAUDESTRUCT_LOG_PROMPTS=1 when you specifically want to mine the
# logs with `cs dataset export`.
#
# Response text is capped because some models will happily emit
# 200k+ tokens before stop_reason fires; uncapped that turns each run
# log into an unreadable wall.
_RUN_IO_RESPONSE_CAP = 100 * 1024  # 100 KB


def run_io(
    *,
    task: str,
    model: str,
    description: str,
    response_text: str,
) -> dict[str, Any]:
    truncated = response_text[:_RUN_IO_RESPONSE_CAP]
    return {
        "ts": _now_iso(),
        "type": "run.io",
        "task": task,
        "model": model,
        "description": description,
        "responseText": truncated,
        "responseTruncated": len(response_text) > _RUN_IO_RESPONSE_CAP,
    }
