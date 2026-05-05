"""MCP handler tests.

Handlers are dict-in/dict-out so we can test them without the SDK or
the network. The `run_task_and_log` call is mocked because it hits the
Anthropic API; everything around it (arg parsing, dashboard / metrics
folding, error shape) is real.
"""
from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import patch

import pytest

from claudestruct import dashboard
from claudestruct.client import RunResult
from claudestruct.mcp_handlers import (
    HANDLERS,
    TOOL_SCHEMAS,
    handle_dashboard,
    handle_dev,
    handle_metrics,
    handle_review,
)
from claudestruct.runner import TaskRunOutcome


def _fake_outcome(text: str = "ok", cost: float = 0.001) -> TaskRunOutcome:
    return TaskRunOutcome(
        result=RunResult(
            text=text,
            input_tokens=100,
            output_tokens=50,
            cache_creation_tokens=0,
            cache_read_tokens=200,
            stop_reason="end_turn",
            model="claude-opus-4-7",
            cache_warning=None,
        ),
        cost_usd=cost,
        duration_ms=1234,
        context_files=3,
        context_total_bytes=2048,
        auto_log_path=Path("/tmp/x.jsonl"),
    )


def test_tool_schemas_match_handlers():
    """Every entry in TOOL_SCHEMAS must have a HANDLERS counterpart and
    vice versa. Catches drift between the catalog the MCP client sees
    and what the server can actually dispatch."""
    schema_names = {t["name"] for t in TOOL_SCHEMAS}
    handler_names = set(HANDLERS.keys())
    assert schema_names == handler_names


def test_tool_schemas_are_well_formed():
    for t in TOOL_SCHEMAS:
        assert t["name"].startswith("claudestruct_")
        assert isinstance(t["description"], str) and t["description"]
        s = t["inputSchema"]
        assert s["type"] == "object"
        assert "properties" in s


def test_handle_dev_passes_args_to_runner(tmp_path):
    """Handler should resolve root, normalize paths, and pass through
    every optional arg to run_task_and_log."""
    captured = {}

    def fake_run(**kwargs):
        captured.update(kwargs)
        return _fake_outcome()

    with patch("claudestruct.mcp_handlers.run_task_and_log", fake_run):
        out = handle_dev({
            "description": "add foo",
            "paths": ["src/foo.py"],
            "root": str(tmp_path),
            "model": "claude-sonnet-4-6",
            "effort": "high",
            "max_tokens": 4000,
            "max_bytes": 200_000,
        })
    assert captured["task"] == "dev"
    assert captured["description"] == "add foo"
    # Path was resolved to absolute under the supplied root.
    assert captured["paths"][0] == tmp_path / "src/foo.py"
    assert captured["root"] == tmp_path.resolve()
    assert captured["model"] == "claude-sonnet-4-6"
    assert captured["effort"] == "high"
    assert captured["max_tokens"] == 4000
    assert captured["max_bytes"] == 200_000
    # Output shape is JSON-friendly.
    assert out["text"] == "ok"
    assert out["model"] == "claude-opus-4-7"
    assert out["costUsd"] == 0.001
    assert "inputTokens" in out and "cacheReadTokens" in out


def test_handle_review_uses_review_task():
    captured = {}

    def fake_run(**kwargs):
        captured.update(kwargs)
        return _fake_outcome()

    with patch("claudestruct.mcp_handlers.run_task_and_log", fake_run):
        handle_review({"description": "review the diff"})
    assert captured["task"] == "review"


def test_handle_dev_without_description_raises():
    with pytest.raises(ValueError, match="description"):
        handle_dev({"paths": ["foo.py"]})


def test_handle_dev_rejects_non_list_paths():
    with pytest.raises(ValueError, match="paths"):
        handle_dev({"description": "x", "paths": "foo.py"})


def test_handle_dashboard_returns_run_list(tmp_path):
    runs_dir = dashboard.runs_dir(tmp_path)
    runs_dir.mkdir(parents=True, exist_ok=True)
    (runs_dir / "run-a.jsonl").write_text(
        '{"type":"run.start","ts":"2026-04-25T00:00:00Z","task":"dev","model":"claude-opus-4-7"}\n'
        '{"type":"agent.usage","ts":"2026-04-25T00:00:01Z","role":"claudestruct",'
        '"provider":"anthropic","model":"claude-opus-4-7","inputTokens":100,'
        '"outputTokens":50,"cacheReadTokens":0,"cacheCreationTokens":0,"costUsd":0.001}\n'
        '{"type":"run.end","ts":"2026-04-25T00:00:02Z","reason":"end_turn",'
        '"durationMs":1500,"totalCostUsd":0.001}\n'
    )
    out = handle_dashboard({"root": str(tmp_path)})
    assert out["count"] == 1
    assert out["runs"][0]["task"] == "dev"
    assert out["runs"][0]["costUsd"] == 0.001


def test_handle_dashboard_filter_by_task(tmp_path):
    runs_dir = dashboard.runs_dir(tmp_path)
    runs_dir.mkdir(parents=True, exist_ok=True)
    (runs_dir / "run-a.jsonl").write_text(
        '{"type":"run.start","ts":"2026-04-25T00:00:00Z","task":"dev"}\n'
    )
    (runs_dir / "run-b.jsonl").write_text(
        '{"type":"run.start","ts":"2026-04-25T01:00:00Z","task":"review"}\n'
    )
    out = handle_dashboard({"root": str(tmp_path), "task": "dev"})
    assert out["count"] == 1
    assert out["runs"][0]["task"] == "dev"


def test_handle_metrics_returns_prometheus_text(tmp_path):
    out = handle_metrics({"root": str(tmp_path)})
    assert "prometheus" in out
    assert "claudestruct_runs_total" in out["prometheus"]
    # Result is JSON-serializable.
    json.dumps(out)
