"""Dataset export for fine-tuning (W10.6).

Walks the JSONL run-log directory (``.claudestruct/runs/*.jsonl``) and
produces a training-ready dataset from ``run.io`` events. The capture
itself is opt-in via ``CLAUDESTRUCT_LOG_PROMPTS=1`` (see
``runner._log_prompts_enabled``); without it, this module finds nothing
because the prompt + response simply weren't recorded.

Two output formats supported, picked by the caller:

* ``alpaca`` (default) — `{instruction, input, output}` triples.
  Consumed natively by axolotl / unsloth / TRL.
* ``chat`` — `{messages: [{role, content}, ...]}`. Better fit for
  fine-tuning chat-tuned bases (Qwen-Coder, Llama-3-Instruct).

The exporter is *additive* — it never modifies the source logs. Filter
flags compose: ``--task review --since 2026-01-01`` yields review-only
runs from the last few months.

Why a separate module instead of a one-liner over ``jq``? Three things
make this worth its own surface:

1. ``run.io`` is one event among many in the JSONL stream; we want to
   skip ``run.start`` / ``agent.usage`` / ``cache.warning`` cleanly
   without pushing that complexity onto the operator.
2. Date filtering needs ISO-timestamp comparison, not string ops.
3. Format conversion (alpaca ↔ chat) is wrong-by-default if you do it
   inline — getting the role labels right matters for downstream
   trainers and we centralise the logic here.
"""
from __future__ import annotations

import json
from collections.abc import Iterator
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

# --- Public types ---------------------------------------------------


@dataclass(frozen=True)
class DatasetStats:
    """Returned by ``export_dataset`` so the CLI can print a useful
    line without re-walking the file we just wrote."""

    rows: int
    skipped_no_io: int
    skipped_filtered: int
    output_path: Path


# --- Walking --------------------------------------------------------


def _runs_dir(root: Path) -> Path:
    """Mirror of ``dashboard.auto_log_path`` — both write to the same
    place. Hoisted so tests can target a fake root cleanly."""
    return root / ".claudestruct" / "runs"


def _parse_iso(ts: str) -> datetime | None:
    """Tolerant ISO-8601 parser. Returns ``None`` on garbage rather
    than raising — a single malformed row shouldn't kill the export."""
    try:
        # ``fromisoformat`` accepts ``2026-05-01T12:34:56+00:00`` directly;
        # the ``Z`` suffix it doesn't, so normalise.
        return datetime.fromisoformat(ts.replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None


def walk_run_io(
    root: Path,
    *,
    since: datetime | None = None,
    task: str | None = None,
) -> Iterator[dict]:
    """Yield ``run.io`` events from every JSONL log under ``root``.

    ``since`` filters by event timestamp (events with no parsable
    ``ts`` field are kept — better to over-include than drop data
    silently). ``task`` filters by the value of the event's ``task``
    field (``"dev"`` / ``"review"`` / ``"plan"`` / ``"debug"``).

    Files that aren't valid JSONL are skipped with no error — operators
    sometimes hand-edit logs and we don't want one bad file to
    blacklist the whole export.
    """
    runs = _runs_dir(root)
    if not runs.exists():
        return
    for path in sorted(runs.glob("*.jsonl")):
        try:
            with path.open("r", encoding="utf-8") as fh:
                for line in fh:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        event = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if not isinstance(event, dict):
                        continue
                    if event.get("type") != "run.io":
                        continue
                    if task is not None and event.get("task") != task:
                        continue
                    if since is not None:
                        ts = _parse_iso(str(event.get("ts", "")))
                        if ts is not None and ts < since:
                            continue
                    yield event
        except OSError:
            continue


# --- Format conversion ---------------------------------------------


_TASK_INSTRUCTIONS = {
    # Short prefixes that orient the trainee on the role expected of
    # the response. We deliberately keep these terse — fine-tunes work
    # better when the instruction template is short and consistent.
    "dev": "You are a software engineer. Write a minimal patch.",
    "review": "You are a senior reviewer. Surface bugs, security issues, and maintainability concerns.",
    "plan": "You are a tech lead. Produce a step-by-step implementation plan.",
    "debug": "You are debugging. Rank hypotheses by likelihood, with verification steps.",
}


def to_alpaca(event: dict) -> dict | None:
    """Convert a ``run.io`` event to ``{instruction, input, output}``.

    Returns ``None`` if the event is missing the fields we need
    (``description`` / ``responseText``) — caller should treat ``None``
    as "skip this row" rather than "raise".
    """
    desc = event.get("description")
    out = event.get("responseText")
    if not isinstance(desc, str) or not isinstance(out, str):
        return None
    if not desc.strip() or not out.strip():
        return None
    task = event.get("task", "")
    return {
        "instruction": _TASK_INSTRUCTIONS.get(task, "Respond to the request below."),
        "input": desc,
        "output": out,
    }


def to_chat(event: dict) -> dict | None:
    """Convert to chat-format `{messages: [...]}`. Same skip semantics
    as ``to_alpaca``."""
    desc = event.get("description")
    out = event.get("responseText")
    if not isinstance(desc, str) or not isinstance(out, str):
        return None
    if not desc.strip() or not out.strip():
        return None
    task = event.get("task", "")
    sys_prompt = _TASK_INSTRUCTIONS.get(task, "Respond to the request below.")
    return {
        "messages": [
            {"role": "system", "content": sys_prompt},
            {"role": "user", "content": desc},
            {"role": "assistant", "content": out},
        ],
    }


_FORMATTERS = {
    "alpaca": to_alpaca,
    "chat": to_chat,
}


# --- Export ---------------------------------------------------------


def export_dataset(
    root: Path,
    out_path: Path,
    *,
    fmt: str = "alpaca",
    task: str | None = None,
    since: datetime | None = None,
) -> DatasetStats:
    """Walk ``root``'s run logs, write training-format JSONL to
    ``out_path``, return a stats summary.

    Empty result is *not* an error — we still create ``out_path`` so a
    downstream pipeline can ``ls`` it without special-casing. The stats
    object distinguishes "skipped because the event lacked IO fields"
    from "skipped because filters didn't match" so operators can debug
    a small dataset count without re-running with verbose logging.
    """
    if fmt not in _FORMATTERS:
        raise ValueError(
            f"unknown dataset format {fmt!r}; choose from {sorted(_FORMATTERS)}"
        )
    formatter = _FORMATTERS[fmt]
    rows = 0
    skipped_no_io = 0
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with out_path.open("w", encoding="utf-8") as fh:
        for event in walk_run_io(root, since=since, task=task):
            converted = formatter(event)
            if converted is None:
                skipped_no_io += 1
                continue
            fh.write(json.dumps(converted, ensure_ascii=False) + "\n")
            rows += 1
    # ``walk_run_io`` already enforces the task/since filters, so
    # "skipped_filtered" is captured indirectly: anything filtered out
    # never reaches this layer. We still expose the counter so future
    # callers (e.g. a verbose mode that walks twice) have a slot.
    return DatasetStats(
        rows=rows,
        skipped_no_io=skipped_no_io,
        skipped_filtered=0,
        output_path=out_path,
    )


# --- Convenience for tests / scripts -------------------------------


def parse_since(value: str) -> datetime:
    """Lenient YYYY-MM-DD or full-ISO parser, used by the CLI flag.
    Raises ``ValueError`` on garbage so Click can surface a clean
    error message."""
    if not value:
        raise ValueError("--since requires a value (YYYY-MM-DD or ISO 8601)")
    parsed = _parse_iso(value)
    if parsed is not None:
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
    # Fall back to date-only.
    try:
        d = datetime.strptime(value, "%Y-%m-%d")
        return d.replace(tzinfo=timezone.utc)
    except ValueError as exc:
        raise ValueError(
            f"--since {value!r}: expected YYYY-MM-DD or ISO 8601 timestamp"
        ) from exc
