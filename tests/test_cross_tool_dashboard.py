"""Tests for the F8 cross-tool dashboard reader.

Both tools write JSONL run logs with parity-tested schemas; this layer
reads claw-squad's slightly-different field names and folds them into
the same `RunSummary` shape so a single dashboard surface covers both.

Cases pin: per-tool provenance (`tool` field), event-name mapping,
and chronological ordering across the combined feed.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from claudestruct import dashboard


def _write_cs_run(tmp_path: Path, name: str, events: list[dict]) -> None:
    p = dashboard.runs_dir(tmp_path) / f"{name}.jsonl"
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text("\n".join(json.dumps(ev) for ev in events) + "\n")


def _write_cw_run(tmp_path: Path, name: str, events: list[dict]) -> None:
    p = dashboard.claw_squad_runs_dir(tmp_path) / f"{name}.jsonl"
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text("\n".join(json.dumps(ev) for ev in events) + "\n")


def test_load_claw_squad_summaries_returns_empty_when_no_dir(tmp_path):
    assert dashboard.load_claw_squad_summaries(tmp_path) == []


def test_load_claw_squad_summaries_folds_usage_events(tmp_path):
    _write_cw_run(tmp_path, "2026-04-25T00-00-00Z", [
        {"type": "run-start", "ts": "2026-04-25T00:00:00Z",
         "requirement": "ship the new auth flow"},
        {"type": "usage", "ts": "2026-04-25T00:00:01Z",
         "role": "planner", "provider": "anthropic",
         "inputTokens": 1000, "outputTokens": 200,
         "cacheReadTokens": 500, "cacheCreationTokens": 0,
         "costUsd": 0.01},
        {"type": "usage", "ts": "2026-04-25T00:00:02Z",
         "role": "coder", "provider": "anthropic",
         "inputTokens": 5000, "outputTokens": 800,
         "cacheReadTokens": 2000, "cacheCreationTokens": 0,
         "costUsd": 0.05},
        {"type": "run-end", "ts": "2026-04-25T00:00:10Z",
         "reason": "complete",
         "overall": {"costUsd": 0.06, "cacheSavedUsd": 0.005, "calls": 2}},
    ])

    rows = dashboard.load_claw_squad_summaries(tmp_path)
    assert len(rows) == 1
    s = rows[0]
    assert s.tool == "claw-squad"
    assert s.task == "ship the new auth flow"
    assert s.input_tokens == 6000
    assert s.output_tokens == 1000
    assert s.cache_read_tokens == 2500
    assert s.cost_usd == pytest.approx(0.06)
    assert s.reason == "complete"


def test_long_requirement_truncated_for_table_readability(tmp_path):
    long_req = "a" * 200
    _write_cw_run(tmp_path, "long", [
        {"type": "run-start", "ts": "2026-04-25T00:00:00Z", "requirement": long_req},
    ])
    rows = dashboard.load_claw_squad_summaries(tmp_path)
    assert rows[0].task and len(rows[0].task) <= 60
    assert rows[0].task.endswith("...")


def test_combined_dashboard_surfaces_both_tools(tmp_path):
    _write_cs_run(tmp_path, "2026-04-25T00-00-00Z", [
        {"type": "run.start", "ts": "2026-04-25T00:00:00Z", "task": "dev",
         "model": "claude-opus-4-7"},
        {"type": "run.end", "ts": "2026-04-25T00:00:01Z", "reason": "end_turn"},
    ])
    _write_cw_run(tmp_path, "2026-04-25T01-00-00Z", [
        {"type": "run-start", "ts": "2026-04-25T01:00:00Z",
         "requirement": "refactor login"},
        {"type": "run-end", "ts": "2026-04-25T01:00:30Z", "reason": "complete"},
    ])

    combined = dashboard.load_summaries_with_claw_squad(tmp_path)
    assert len(combined) == 2
    tools = {row.tool for row in combined}
    assert tools == {"claudestruct", "claw-squad"}


def test_combined_dashboard_sorts_chronologically(tmp_path):
    _write_cs_run(tmp_path, "later", [
        {"type": "run.start", "ts": "2026-04-25T03:00:00Z", "task": "review"},
    ])
    _write_cw_run(tmp_path, "earlier", [
        {"type": "run-start", "ts": "2026-04-25T01:00:00Z",
         "requirement": "first"},
    ])
    _write_cs_run(tmp_path, "middle", [
        {"type": "run.start", "ts": "2026-04-25T02:00:00Z", "task": "dev"},
    ])

    combined = dashboard.load_summaries_with_claw_squad(tmp_path)
    timestamps = [s.started_at for s in combined]
    assert timestamps == sorted(timestamps)


def test_to_json_preserves_tool_field(tmp_path):
    _write_cs_run(tmp_path, "a", [
        {"type": "run.start", "ts": "2026-04-25T00:00:00Z", "task": "dev"},
    ])
    _write_cw_run(tmp_path, "b", [
        {"type": "run-start", "ts": "2026-04-25T01:00:00Z", "requirement": "x"},
    ])
    rows = dashboard.load_summaries_with_claw_squad(tmp_path)
    parsed = json.loads(dashboard.to_json(rows))
    tools = {r["tool"] for r in parsed}
    assert tools == {"claudestruct", "claw-squad"}


def test_claw_squad_only_dir_still_works(tmp_path):
    """User running claw-squad without ever using claudestruct directly."""
    _write_cw_run(tmp_path, "a", [
        {"type": "run-start", "ts": "2026-04-25T00:00:00Z", "requirement": "x"},
    ])
    combined = dashboard.load_summaries_with_claw_squad(tmp_path)
    assert len(combined) == 1
    assert combined[0].tool == "claw-squad"
