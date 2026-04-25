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
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import IO, Any, Iterator


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


@dataclass
class EventSink:
    """Append-only JSON-lines writer.

    Best-effort: a write failure is swallowed (logged via stderr by the
    caller's exception handler if needed) so an observability blip
    never breaks the user's actual run.
    """

    path: Path
    _fh: IO[str] | None = None

    def open(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._fh = self.path.open("a", encoding="utf-8")

    def write(self, event: dict[str, Any]) -> None:
        if self._fh is None:
            return
        try:
            self._fh.write(json.dumps(event, separators=(",", ":")) + "\n")
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


def make_sink(path: str | None) -> EventSink | NullSink:
    if not path:
        return NullSink()
    return EventSink(path=Path(path).expanduser())


@contextmanager
def event_log(path: str | None) -> Iterator[EventSink | NullSink]:
    sink = make_sink(path)
    sink.open()
    try:
        yield sink
    finally:
        sink.close()


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
