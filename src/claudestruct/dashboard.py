"""Run dashboard for claudestruct.

Folds the per-run JSONL event logs (under `<root>/.claudestruct/runs/`)
into a per-run summary table. Mirrors `claw-squad`'s `dashboard` command
so users with both tools see the same shape.

We do NOT share a Python+TS package for this — copy-paste of ~150 lines
beats a dual-distributed package. The schema parity is what matters
(both write `run.start` / `agent.usage` / `cache.warning` / `run.end`),
and that's locked by the structured logging tests on each side.
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable, Iterator


@dataclass
class RunSummary:
    """Folded summary of one run's JSONL event stream."""

    run_id: str
    path: Path
    started_at: str | None = None
    ended_at: str | None = None
    task: str | None = None
    model: str | None = None
    effort: str | None = None
    prompt_version: str | None = None
    reason: str | None = None
    duration_ms: int | None = None
    input_tokens: int = 0
    output_tokens: int = 0
    cache_read_tokens: int = 0
    cache_creation_tokens: int = 0
    cost_usd: float = 0.0
    cache_warnings: list[str] = field(default_factory=list)
    # Which tool produced this run. "claudestruct" for the local CLI;
    # "claw-squad" when surfaced via --include-claw-squad. Lets the
    # combined dashboard show provenance per row.
    tool: str = "claudestruct"


def runs_dir(root: Path) -> Path:
    return Path(root) / ".claudestruct" / "runs"


def auto_log_path(root: Path) -> Path:
    """Path for the auto-emitted run log. Filename is the start time
    with `:` and `.` flattened so `ls` and the dashboard can sort
    chronologically without parsing."""
    ts = datetime.now(timezone.utc).isoformat()
    slug = ts.replace(":", "-").replace(".", "-")
    return runs_dir(root) / f"{slug}.jsonl"


def load_summaries(root: Path) -> list[RunSummary]:
    d = runs_dir(root)
    if not d.exists():
        return []
    out: list[RunSummary] = []
    for p in sorted(d.iterdir()):
        if p.suffix != ".jsonl":
            continue
        out.append(_fold(p))
    return out


def _iter_events(path: Path) -> Iterator[dict]:
    try:
        raw = path.read_text(encoding="utf-8")
    except OSError:
        return
    for line in raw.split("\n"):
        if not line:
            continue
        try:
            yield json.loads(line)
        except json.JSONDecodeError:
            # Best-effort reader: one malformed line shouldn't hide
            # the rest of the run. Mirrors claw-squad's loadOneRun.
            continue


def _fold(path: Path) -> RunSummary:
    s = RunSummary(run_id=path.stem, path=path)
    for ev in _iter_events(path):
        t = ev.get("type")
        if t == "run.start":
            s.started_at = ev.get("ts")
            s.task = ev.get("task")
            s.model = ev.get("model")
            s.effort = ev.get("effort")
            s.prompt_version = ev.get("promptVersion")
        elif t == "agent.usage":
            s.input_tokens += int(ev.get("inputTokens", 0) or 0)
            s.output_tokens += int(ev.get("outputTokens", 0) or 0)
            s.cache_read_tokens += int(ev.get("cacheReadTokens", 0) or 0)
            s.cache_creation_tokens += int(ev.get("cacheCreationTokens", 0) or 0)
            s.cost_usd += float(ev.get("costUsd", 0.0) or 0.0)
        elif t == "cache.warning":
            msg = ev.get("message")
            if isinstance(msg, str):
                s.cache_warnings.append(msg)
        elif t == "run.end":
            s.ended_at = ev.get("ts")
            s.reason = ev.get("reason")
            d_ms = ev.get("durationMs")
            if isinstance(d_ms, (int, float)):
                s.duration_ms = int(d_ms)
            # Trust per-call cost accumulation over the run-end total —
            # they should match, but a partial run (interrupted before
            # run-end) still has a useful number from agent.usage.
    return s


def filter_summaries(
    summaries: Iterable[RunSummary],
    task: str | None = None,
    since: datetime | None = None,
) -> list[RunSummary]:
    out: list[RunSummary] = []
    for s in summaries:
        if task and s.task != task:
            continue
        if since and s.started_at:
            try:
                ts = datetime.fromisoformat(s.started_at)
            except ValueError:
                ts = None
            if ts and ts < since:
                continue
        out.append(s)
    return out


# --- Cross-tool: claw-squad run log support (F8) ---

def claw_squad_runs_dir(root: Path) -> Path:
    return Path(root) / ".claw-squad" / "runs"


def _fold_claw_squad(path: Path) -> RunSummary:
    """Translate a claw-squad JSONL stream into a RunSummary.

    Schema differences vs claudestruct's own writer:
      - Event types use hyphens: `run-start`, `usage`, `run-end`.
      - `usage` events come per-role; we sum all of them into a single
        run-level row. Per-role detail is preserved in the original
        file for anyone who wants the multi-agent breakdown.
      - `requirement` (free text) replaces `task` since claw-squad
        doesn't categorize like dev/review/plan/debug.
      - `model` is per-call (each agent picks its own). We pick the
        first non-empty value seen so the table has *something*; the
        original log retains the per-role detail.
    """
    s = RunSummary(run_id=path.stem, path=path, tool="claw-squad")
    for ev in _iter_events(path):
        t = ev.get("type")
        if t == "run-start":
            s.started_at = ev.get("ts")
            req = ev.get("requirement")
            if isinstance(req, str):
                # Truncate long requirements so the dashboard table
                # stays readable; the run log keeps the full text.
                s.task = req if len(req) <= 60 else req[:57] + "..."
        elif t == "usage":
            s.input_tokens += int(ev.get("inputTokens", 0) or 0)
            s.output_tokens += int(ev.get("outputTokens", 0) or 0)
            s.cache_read_tokens += int(ev.get("cacheReadTokens", 0) or 0)
            s.cache_creation_tokens += int(ev.get("cacheCreationTokens", 0) or 0)
            s.cost_usd += float(ev.get("costUsd", 0.0) or 0.0)
            if not s.model:
                provider = ev.get("provider")
                if isinstance(provider, str):
                    s.model = provider
        elif t == "run-end":
            s.ended_at = ev.get("ts")
            s.reason = ev.get("reason")
    return s


def load_claw_squad_summaries(root: Path) -> list[RunSummary]:
    d = claw_squad_runs_dir(root)
    if not d.exists():
        return []
    out: list[RunSummary] = []
    for p in sorted(d.iterdir()):
        if p.suffix != ".jsonl":
            continue
        out.append(_fold_claw_squad(p))
    return out


def load_summaries_with_claw_squad(root: Path) -> list[RunSummary]:
    """Combined summaries from both tools, sorted chronologically by
    `started_at`. Rows with missing timestamps sink to the front
    (oldest-looking) so they don't bury current activity."""
    cs = load_summaries(root)
    cw = load_claw_squad_summaries(root)
    combined = cs + cw
    combined.sort(key=lambda s: s.started_at or "")
    return combined


def to_json(summaries: Iterable[RunSummary]) -> str:
    """Machine-readable rendering: one JSON array, suitable for `jq` or
    spreadsheet ingest. Matches the field names in `RunSummary` minus
    the `path` (which is filesystem-specific noise)."""
    rows = []
    for s in summaries:
        rows.append({
            "runId": s.run_id,
            "tool": s.tool,
            "startedAt": s.started_at,
            "endedAt": s.ended_at,
            "task": s.task,
            "model": s.model,
            "effort": s.effort,
            "promptVersion": s.prompt_version,
            "reason": s.reason,
            "durationMs": s.duration_ms,
            "inputTokens": s.input_tokens,
            "outputTokens": s.output_tokens,
            "cacheReadTokens": s.cache_read_tokens,
            "cacheCreationTokens": s.cache_creation_tokens,
            "costUsd": round(s.cost_usd, 6),
            "cacheWarnings": s.cache_warnings,
        })
    return json.dumps(rows, indent=2)
