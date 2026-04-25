"""Tests for the run-log dashboard reader.

The dashboard is a thin fold over the JSONL stream — its correctness
hinges on event-shape parity with the writer (`logging.py`). These
tests round-trip writer → reader so a future schema drift fails loudly.
"""
from __future__ import annotations

import json
from datetime import datetime, timezone

import pytest

from claudestruct import dashboard
from claudestruct import logging as event_log


def _write_run(path, events):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as fh:
        for ev in events:
            fh.write(json.dumps(ev) + "\n")


def test_load_empty_dir(tmp_path):
    assert dashboard.load_summaries(tmp_path) == []


def test_fold_round_trips_writer_output(tmp_path):
    """Writer + reader contract: feed real events from logging.py, then
    fold them back. The shape stays compatible across releases as long
    as both sides agree on the field names."""
    p = dashboard.runs_dir(tmp_path) / "2026-04-25T00-00-00.jsonl"
    p.parent.mkdir(parents=True, exist_ok=True)
    sink = event_log.EventSink(path=p)
    sink.open()
    sink.write(event_log.run_start(
        task="dev", model="claude-opus-4-7", effort="high",
        prompt_version="abcd1234",
    ))
    sink.write(event_log.agent_usage(
        role="claudestruct", provider="anthropic", model="claude-opus-4-7",
        input_tokens=1000, output_tokens=200,
        cache_read_tokens=5000, cache_creation_tokens=0,
        cost_usd=0.0125,
    ))
    sink.write(event_log.cache_warning("prefix invalidated"))
    sink.write(event_log.run_end(reason="end_turn", duration_ms=4321, total_cost_usd=0.0125))
    sink.close()

    rows = dashboard.load_summaries(tmp_path)
    assert len(rows) == 1
    s = rows[0]
    assert s.task == "dev"
    assert s.model == "claude-opus-4-7"
    assert s.effort == "high"
    assert s.prompt_version == "abcd1234"
    assert s.input_tokens == 1000
    assert s.output_tokens == 200
    assert s.cache_read_tokens == 5000
    assert s.cost_usd == pytest.approx(0.0125)
    assert s.duration_ms == 4321
    assert s.reason == "end_turn"
    assert s.cache_warnings == ["prefix invalidated"]


def test_load_summaries_sorts_chronologically(tmp_path):
    _write_run(dashboard.runs_dir(tmp_path) / "2026-04-25T01-00-00.jsonl", [
        {"type": "run.start", "ts": "2026-04-25T01:00:00+00:00", "task": "dev"},
        {"type": "run.end", "ts": "2026-04-25T01:00:01+00:00", "reason": "end_turn"},
    ])
    _write_run(dashboard.runs_dir(tmp_path) / "2026-04-25T00-00-00.jsonl", [
        {"type": "run.start", "ts": "2026-04-25T00:00:00+00:00", "task": "review"},
        {"type": "run.end", "ts": "2026-04-25T00:00:01+00:00", "reason": "end_turn"},
    ])
    rows = dashboard.load_summaries(tmp_path)
    assert [r.task for r in rows] == ["review", "dev"]


def test_malformed_line_is_skipped_not_fatal(tmp_path):
    p = dashboard.runs_dir(tmp_path) / "bad.jsonl"
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(
        '{"type":"run.start","ts":"2026-04-25T00:00:00Z","task":"dev"}\n'
        'not-json\n'
        '{"type":"run.end","ts":"2026-04-25T00:00:01Z","reason":"end_turn"}\n'
    )
    rows = dashboard.load_summaries(tmp_path)
    assert len(rows) == 1
    assert rows[0].task == "dev"
    assert rows[0].reason == "end_turn"


def test_filter_by_task(tmp_path):
    _write_run(dashboard.runs_dir(tmp_path) / "a.jsonl",
               [{"type": "run.start", "ts": "2026-04-25T00:00:00Z", "task": "dev"}])
    _write_run(dashboard.runs_dir(tmp_path) / "b.jsonl",
               [{"type": "run.start", "ts": "2026-04-25T00:00:01Z", "task": "review"}])
    rows = dashboard.load_summaries(tmp_path)
    assert len(dashboard.filter_summaries(rows, task="dev")) == 1
    assert len(dashboard.filter_summaries(rows, task="review")) == 1
    assert len(dashboard.filter_summaries(rows, task="plan")) == 0


def test_filter_by_since(tmp_path):
    _write_run(dashboard.runs_dir(tmp_path) / "a.jsonl",
               [{"type": "run.start", "ts": "2026-04-24T00:00:00+00:00", "task": "dev"}])
    _write_run(dashboard.runs_dir(tmp_path) / "b.jsonl",
               [{"type": "run.start", "ts": "2026-04-26T00:00:00+00:00", "task": "dev"}])
    rows = dashboard.load_summaries(tmp_path)
    cutoff = datetime(2026, 4, 25, tzinfo=timezone.utc)
    after = dashboard.filter_summaries(rows, since=cutoff)
    assert len(after) == 1
    assert after[0].started_at.startswith("2026-04-26")


def test_to_json_emits_field_names_used_by_consumers(tmp_path):
    _write_run(dashboard.runs_dir(tmp_path) / "a.jsonl", [
        {"type": "run.start", "ts": "2026-04-25T00:00:00Z", "task": "dev",
         "model": "claude-opus-4-7", "effort": "high", "promptVersion": "abc12345"},
        {"type": "agent.usage", "ts": "2026-04-25T00:00:01Z",
         "role": "claudestruct", "provider": "anthropic",
         "model": "claude-opus-4-7", "inputTokens": 100, "outputTokens": 50,
         "cacheReadTokens": 0, "cacheCreationTokens": 0, "costUsd": 0.001},
        {"type": "run.end", "ts": "2026-04-25T00:00:02Z", "reason": "end_turn",
         "durationMs": 1000, "totalCostUsd": 0.001},
    ])
    rows = dashboard.load_summaries(tmp_path)
    parsed = json.loads(dashboard.to_json(rows))
    assert len(parsed) == 1
    expected_keys = {
        "runId", "startedAt", "endedAt", "task", "model", "effort",
        "promptVersion", "reason", "durationMs",
        "inputTokens", "outputTokens", "cacheReadTokens", "cacheCreationTokens",
        "costUsd", "cacheWarnings",
    }
    assert expected_keys.issubset(set(parsed[0].keys()))
