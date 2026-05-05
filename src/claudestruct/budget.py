"""Cumulative budget checks (W5.6).

Per-run budgets (`--max-tokens`, `--max-bytes`) only protect against a
single runaway invocation. This module aggregates spend across all runs
in `<root>/.claudestruct/runs/*.jsonl` for the current calendar month
(UTC) and reports whether a configured cap has been crossed.

Hard-aborts in the CLI before the next LLM call when `spent >= cap`.
Soft-warns at `WARN_FRACTION * cap` (default 80%).

Time semantics: calendar month in UTC. A run is counted when its
`run.start.ts` falls within `[period_start, period_end)`. Runs without
a parseable `startedAt` are ignored — the dashboard's existing logic
treats them the same way.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from claudestruct.dashboard import RunSummary, load_summaries

WARN_FRACTION = 0.8


@dataclass
class BudgetStatus:
    """Result of `check_budget`. All amounts in USD."""

    spent_usd: float
    cap_usd: float
    warn_threshold_usd: float
    exceeded: bool
    near_limit: bool

    def remaining_usd(self) -> float:
        return max(0.0, self.cap_usd - self.spent_usd)


def month_bounds(now: datetime) -> tuple[datetime, datetime]:
    """Return [period_start, period_end) for the calendar month containing `now`.

    Both bounds are timezone-aware UTC datetimes. `now` is normalized
    to UTC if it carries a different tz.
    """
    n = now.astimezone(timezone.utc)
    start = n.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    if n.month == 12:
        end = start.replace(year=n.year + 1, month=1)
    else:
        end = start.replace(month=n.month + 1)
    return start, end


def _started_in_period(s: RunSummary, period_start: datetime, period_end: datetime) -> bool:
    if not s.started_at:
        return False
    try:
        ts = datetime.fromisoformat(s.started_at)
    except ValueError:
        return False
    if ts.tzinfo is None:
        ts = ts.replace(tzinfo=timezone.utc)
    return period_start <= ts < period_end


def current_period_spend(
    root: Path,
    *,
    now: datetime | None = None,
) -> float:
    """Sum `cost_usd` across runs whose `startedAt` is in the current UTC month."""
    n = now if now is not None else datetime.now(timezone.utc)
    period_start, period_end = month_bounds(n)
    total = 0.0
    for s in load_summaries(root):
        if _started_in_period(s, period_start, period_end):
            total += s.cost_usd
    return total


def check_budget(
    root: Path,
    cap_usd: float,
    *,
    warn_fraction: float = WARN_FRACTION,
    now: datetime | None = None,
) -> BudgetStatus:
    """Compare current-period spend against `cap_usd`.

    `cap_usd <= 0` is treated as "no cap" — returns a status with the
    raw spend but `exceeded=False, near_limit=False`. Caller decides
    whether to surface that.
    """
    spent = current_period_spend(root, now=now)
    if cap_usd <= 0:
        return BudgetStatus(
            spent_usd=spent,
            cap_usd=cap_usd,
            warn_threshold_usd=0.0,
            exceeded=False,
            near_limit=False,
        )
    warn_threshold = cap_usd * warn_fraction
    return BudgetStatus(
        spent_usd=spent,
        cap_usd=cap_usd,
        warn_threshold_usd=warn_threshold,
        exceeded=spent >= cap_usd,
        near_limit=spent >= warn_threshold,
    )
