"""Per-task context-budget defaults.

Each task type has different context shape needs. The budgets in
context.py encode that taste; these tests pin the values and the
fallback for unknown task names so a future refactor doesn't silently
collapse them back to a single global default.
"""
from __future__ import annotations

from claudestruct.context import (
    BUDGETS_PER_TASK,
    DEFAULT_MAX_TOTAL_BYTES,
    task_budget,
)


def test_every_known_task_has_a_budget():
    for task in ("dev", "review", "plan", "debug"):
        assert task in BUDGETS_PER_TASK, f"missing budget for {task}"
        assert BUDGETS_PER_TASK[task] > 0


def test_review_budget_is_smaller_than_dev():
    """Reviewer works off the diff, not the world — should ask for less."""
    assert BUDGETS_PER_TASK["review"] < BUDGETS_PER_TASK["dev"]


def test_plan_budget_is_largest():
    """Architecture work earns its keep with more context."""
    assert BUDGETS_PER_TASK["plan"] >= max(
        BUDGETS_PER_TASK[t] for t in ("dev", "review", "debug")
    )


def test_unknown_task_falls_back_to_default():
    assert task_budget("does-not-exist") == DEFAULT_MAX_TOTAL_BYTES


def test_default_matches_dev_budget():
    """The legacy DEFAULT_MAX_TOTAL_BYTES is now an alias for the dev
    budget — anything else would silently shift behavior for callers
    relying on the historical 600k cap."""
    assert BUDGETS_PER_TASK["dev"] == DEFAULT_MAX_TOTAL_BYTES
