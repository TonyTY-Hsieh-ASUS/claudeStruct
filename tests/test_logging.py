"""Tests for the JSONL event sink.

The sink is best-effort: it must never break a real run, even if the
filesystem rejects writes mid-run. We pin both happy-path round-tripping
and failure-mode resilience here.
"""
from __future__ import annotations

import json

import pytest

from claudestruct import logging as event_log
from claudestruct.cost import estimate_cost_usd


def test_null_sink_swallows_events(capsys):
    """No path → no IO, no error."""
    sink = event_log.make_sink(None)
    sink.open()
    sink.write(event_log.run_start(task="dev", model="m", effort=None, prompt_version="abc"))
    sink.close()
    out = capsys.readouterr()
    assert out.out == "" and out.err == ""


def test_event_log_writes_jsonl(tmp_path):
    p = tmp_path / "run.jsonl"
    with event_log.event_log(str(p)) as sink:
        sink.write(event_log.run_start(
            task="review", model="claude-opus-4-7", effort="high", prompt_version="deadbeef",
        ))
        sink.write(event_log.agent_usage(
            role="claudestruct", provider="anthropic", model="claude-opus-4-7",
            input_tokens=100, output_tokens=50,
            cache_read_tokens=200, cache_creation_tokens=0,
            cost_usd=0.0042,
        ))
        sink.write(event_log.run_end(reason="end_turn", duration_ms=1234, total_cost_usd=0.0042))

    lines = p.read_text().splitlines()
    assert len(lines) == 3
    parsed = [json.loads(line) for line in lines]
    assert parsed[0]["type"] == "run.start"
    assert parsed[0]["promptVersion"] == "deadbeef"
    assert parsed[1]["type"] == "agent.usage"
    assert parsed[1]["inputTokens"] == 100
    assert parsed[2]["type"] == "run.end"
    assert parsed[2]["durationMs"] == 1234


def test_event_log_appends_across_runs(tmp_path):
    """Two CLI invocations sharing a log path should accumulate, not truncate."""
    p = tmp_path / "run.jsonl"
    with event_log.event_log(str(p)) as s:
        s.write(event_log.run_end(reason="end_turn", duration_ms=10, total_cost_usd=0))
    with event_log.event_log(str(p)) as s:
        s.write(event_log.run_end(reason="end_turn", duration_ms=20, total_cost_usd=0))
    assert len(p.read_text().splitlines()) == 2


def test_event_log_creates_parent_dirs(tmp_path):
    p = tmp_path / "deep" / "nested" / "run.jsonl"
    with event_log.event_log(str(p)) as s:
        s.write(event_log.run_end(reason="end_turn", duration_ms=0, total_cost_usd=0))
    assert p.exists()


def test_cache_warning_event_carries_message():
    e = event_log.cache_warning("prefix may be invalidating cache")
    assert e["type"] == "cache.warning"
    assert "invalidating" in e["message"]


def test_estimate_cost_known_model():
    # 1M input @ $5 + 1M output @ $25 = $30 for opus.
    cost = estimate_cost_usd(
        model="claude-opus-4-7",
        input_tokens=1_000_000,
        output_tokens=1_000_000,
        cache_read_tokens=0,
        cache_creation_tokens=0,
    )
    assert cost == pytest.approx(30.0)


def test_estimate_cost_unknown_model_falls_back_to_opus():
    cost = estimate_cost_usd(
        model="some-future-model",
        input_tokens=1_000_000, output_tokens=0,
        cache_read_tokens=0, cache_creation_tokens=0,
    )
    assert cost == pytest.approx(5.0)


def test_estimate_cost_includes_cache_columns():
    cost = estimate_cost_usd(
        model="claude-opus-4-7",
        input_tokens=0, output_tokens=0,
        cache_read_tokens=1_000_000,
        cache_creation_tokens=1_000_000,
    )
    # cache_read $0.5 + cache_write $10 = $10.5
    assert cost == pytest.approx(10.5)
