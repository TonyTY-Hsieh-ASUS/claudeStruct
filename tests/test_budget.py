"""Tests for the cumulative monthly budget check (W5.6).

Synthesizes JSONL run logs at known timestamps and verifies that
`current_period_spend` and `check_budget` correctly window to the
current calendar month, sum costs, and trip the warn / exceeded
thresholds.
"""
from __future__ import annotations

import json
from datetime import datetime, timezone

import pytest

from claudestruct import budget


def _write_run(root, run_id, started_at, cost_usd):
    """Write a minimal JSONL stream the dashboard can fold."""
    runs_dir = root / ".claudestruct" / "runs"
    runs_dir.mkdir(parents=True, exist_ok=True)
    path = runs_dir / f"{run_id}.jsonl"
    events = [
        {"type": "run.start", "ts": started_at, "task": "dev",
         "model": "claude-opus-4-7", "effort": "high", "promptVersion": "dev v=abc"},
        {"type": "agent.usage", "ts": started_at, "task": "dev",
         "model": "claude-opus-4-7", "inputTokens": 100, "outputTokens": 50,
         "cacheReadTokens": 0, "cacheCreationTokens": 0, "costUsd": cost_usd},
        {"type": "run.end", "ts": started_at, "reason": "complete",
         "durationMs": 1000, "totalCostUsd": cost_usd},
    ]
    with path.open("w", encoding="utf-8") as fh:
        for ev in events:
            fh.write(json.dumps(ev) + "\n")


def test_no_runs_dir_returns_zero_spend(tmp_path):
    assert budget.current_period_spend(tmp_path) == 0.0


def test_month_bounds_typical_case():
    now = datetime(2026, 4, 15, 10, 30, tzinfo=timezone.utc)
    start, end = budget.month_bounds(now)
    assert start == datetime(2026, 4, 1, tzinfo=timezone.utc)
    assert end == datetime(2026, 5, 1, tzinfo=timezone.utc)


def test_month_bounds_december_rolls_year():
    now = datetime(2026, 12, 20, tzinfo=timezone.utc)
    start, end = budget.month_bounds(now)
    assert start == datetime(2026, 12, 1, tzinfo=timezone.utc)
    assert end == datetime(2027, 1, 1, tzinfo=timezone.utc)


def test_spend_includes_only_current_month(tmp_path):
    # Two runs in April, one in March, one in May.
    _write_run(tmp_path, "r1", "2026-04-05T10:00:00+00:00", 1.50)
    _write_run(tmp_path, "r2", "2026-04-20T10:00:00+00:00", 2.25)
    _write_run(tmp_path, "r3", "2026-03-31T23:59:59+00:00", 99.00)
    _write_run(tmp_path, "r4", "2026-05-01T00:00:00+00:00", 99.00)
    now = datetime(2026, 4, 15, tzinfo=timezone.utc)
    assert budget.current_period_spend(tmp_path, now=now) == pytest.approx(3.75)


def test_spend_handles_naive_iso_timestamps(tmp_path):
    # Some loggers emit timestamps without an explicit offset; treat them
    # as UTC rather than dropping the run.
    _write_run(tmp_path, "naive", "2026-04-10T12:00:00", 1.00)
    now = datetime(2026, 4, 15, tzinfo=timezone.utc)
    assert budget.current_period_spend(tmp_path, now=now) == pytest.approx(1.00)


def test_check_budget_under_threshold(tmp_path):
    _write_run(tmp_path, "r1", "2026-04-05T10:00:00+00:00", 5.00)
    now = datetime(2026, 4, 15, tzinfo=timezone.utc)
    status = budget.check_budget(tmp_path, cap_usd=100.0, now=now)
    assert status.spent_usd == pytest.approx(5.00)
    assert status.cap_usd == 100.0
    assert status.warn_threshold_usd == pytest.approx(80.0)
    assert status.exceeded is False
    assert status.near_limit is False
    assert status.remaining_usd() == pytest.approx(95.0)


def test_check_budget_at_warn_threshold(tmp_path):
    # Exactly 80% of cap → near_limit but not exceeded.
    _write_run(tmp_path, "r1", "2026-04-05T10:00:00+00:00", 80.00)
    now = datetime(2026, 4, 15, tzinfo=timezone.utc)
    status = budget.check_budget(tmp_path, cap_usd=100.0, now=now)
    assert status.near_limit is True
    assert status.exceeded is False


def test_check_budget_at_cap_exceeds(tmp_path):
    # spent == cap → exceeded (>= comparison; the next call would push us over).
    _write_run(tmp_path, "r1", "2026-04-05T10:00:00+00:00", 100.00)
    now = datetime(2026, 4, 15, tzinfo=timezone.utc)
    status = budget.check_budget(tmp_path, cap_usd=100.0, now=now)
    assert status.exceeded is True
    assert status.near_limit is True
    assert status.remaining_usd() == 0.0


def test_check_budget_zero_cap_disables_check(tmp_path):
    _write_run(tmp_path, "r1", "2026-04-05T10:00:00+00:00", 50.00)
    now = datetime(2026, 4, 15, tzinfo=timezone.utc)
    status = budget.check_budget(tmp_path, cap_usd=0.0, now=now)
    assert status.spent_usd == pytest.approx(50.0)
    assert status.exceeded is False
    assert status.near_limit is False


def test_custom_warn_fraction(tmp_path):
    _write_run(tmp_path, "r1", "2026-04-05T10:00:00+00:00", 50.00)
    now = datetime(2026, 4, 15, tzinfo=timezone.utc)
    status = budget.check_budget(
        tmp_path, cap_usd=100.0, warn_fraction=0.5, now=now,
    )
    assert status.warn_threshold_usd == pytest.approx(50.0)
    assert status.near_limit is True


def test_skips_runs_without_start_timestamp(tmp_path):
    # Manually craft a run log that's missing run.start (e.g. crash before
    # logging) — should be silently ignored.
    runs_dir = tmp_path / ".claudestruct" / "runs"
    runs_dir.mkdir(parents=True)
    (runs_dir / "broken.jsonl").write_text(
        json.dumps({"type": "agent.usage", "costUsd": 999.0}) + "\n",
        encoding="utf-8",
    )
    now = datetime(2026, 4, 15, tzinfo=timezone.utc)
    assert budget.current_period_spend(tmp_path, now=now) == 0.0
