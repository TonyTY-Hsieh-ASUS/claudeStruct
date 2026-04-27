"""Daemon-mode background runner (W6.1).

The HTTP API drops `Run` rows in `status="queued"`. A worker picks
them up one at a time, executes ``runner.run_task_and_log`` against
the Anthropic API, and persists the outcome.

Two execution modes:

- **Synchronous, drain-once**: ``process_pending_run(session, run_root)``
  pulls one queued run, runs it inline, returns. Tests and short-lived
  scripts call this directly.
- **Long-running thread**: ``WorkerThread(run_root, session_factory).start()``
  loops the synchronous helper with a sleep when the queue is empty.
  Used by ``cs serve worker`` and (optionally) by the API server's
  startup hook.

Why a thread, not asyncio: the LLM streaming call already blocks for
seconds-to-minutes, so the perf cost of one busy thread is trivial,
and we keep the API server's event loop free for HTTP.

What this module does NOT do (yet):
  - Distributed locks / multiple workers per DB. SELECT-FOR-UPDATE
    keeps a single worker safe; running two workers needs a separate
    coordination story (Redis, Postgres advisory lock, etc.) tracked
    in W6.1 follow-ups.
  - Per-org queue isolation. All queued runs share one queue; a
    runaway org can starve everyone else. Tracked under W8.5.
"""
from __future__ import annotations

import json
import logging
import threading
import time
from collections.abc import Callable
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from claudestruct.client import ClaudestructError
from claudestruct.context import (
    gather_debug_context,
    gather_dev_context,
    gather_plan_context,
    gather_review_context,
)
from claudestruct.runner import run_task_and_log
from claudestruct.server import billing as billing_mod
from claudestruct.server.models import Run, RunStatus

log = logging.getLogger("claudestruct.server.worker")

_GATHERERS: dict[str, Callable[..., Any]] = {
    "dev": gather_dev_context,
    "review": gather_review_context,
    "plan": gather_plan_context,
    "debug": gather_debug_context,
}


def _now_utc() -> datetime:
    return datetime.now(timezone.utc)


def _org_concurrency(session: Session, org_id: int) -> int:
    """How many runs are currently `running` for this org. Used to gate
    the per-tier concurrency cap (W8.3)."""
    rows = session.execute(
        select(Run.id).where(
            Run.org_id == org_id,
            Run.status == RunStatus.running.value,
        )
    ).all()
    return len(rows)


def _claim_one(session: Session) -> Run | None:
    """Atomically move the next eligible queued Run to running.

    Selection rules (W8.3 tenant-scoped sandbox):
      1. Skip orgs that are already at their tier's concurrency cap —
         their rows stay queued and get picked when a slot frees.
      2. Among eligible orgs, pick by tier priority (business > team
         > free), breaking ties on `created_at` (FIFO within a tier).

    On Postgres this would be one SELECT-FOR-UPDATE-SKIP-LOCKED; on
    SQLite + small queues we fold in Python after a wider fetch,
    which scales fine to thousands of queued rows. When we move to
    Postgres the SELECT can include a window function instead.
    """
    queued = list(session.execute(
        select(Run).where(Run.status == RunStatus.queued.value).order_by(Run.created_at)
    ).scalars())
    if not queued:
        return None

    # Resolve each org once — the Subscription read is cheap with
    # the per-org index but doing it per-row would be wasteful.
    org_to_tier: dict[int, str] = {}
    org_concurrency: dict[int, int] = {}
    eligible: list[tuple[int, Run]] = []
    for run in queued:
        if run.org_id not in org_to_tier:
            sub = billing_mod.get_or_default(session, run.org_id)
            org_to_tier[run.org_id] = sub.tier
            org_concurrency[run.org_id] = _org_concurrency(session, run.org_id)
        tier = org_to_tier[run.org_id]
        limit = billing_mod.sandbox_limits_for_tier(tier).max_concurrent_runs
        if org_concurrency[run.org_id] >= limit:
            continue
        priority = billing_mod.tier_priority_for(tier)
        eligible.append((priority, run))

    if not eligible:
        return None
    # Highest priority first; created_at is already the secondary
    # order from the `queued` list since stable Python sort preserves it.
    eligible.sort(key=lambda x: -x[0])
    chosen = eligible[0][1]

    chosen.status = RunStatus.running.value
    chosen.started_at = _now_utc()
    session.commit()
    session.refresh(chosen)
    return chosen


def process_pending_run(
    session: Session,
    run_root: str | Path,
    *,
    runner: Callable[..., Any] = run_task_and_log,
) -> Run | None:
    """Drain at most one queued run from the DB.

    Returns the executed Run row (with its terminal status), or None
    when the queue was empty. Exceptions inside the underlying
    ``runner`` are caught and recorded on the row so the worker loop
    can keep going after a single bad request.

    The ``runner`` keyword exists to let tests inject a fake without
    monkeypatching the real Anthropic SDK.
    """
    run = _claim_one(session)
    if run is None:
        return None

    paths: list[Path] | None = None
    if run.paths_json:
        try:
            raw = json.loads(run.paths_json)
            if isinstance(raw, list):
                paths = [Path(p) for p in raw if isinstance(p, str)]
        except json.JSONDecodeError:
            paths = None

    gatherer = _GATHERERS.get(run.task)
    if gatherer is None:
        run.status = RunStatus.failed.value
        run.error = f"unknown task type: {run.task!r}"
        run.ended_at = _now_utc()
        session.commit()
        log.warning("worker rejected run %s: %s", run.run_id, run.error)
        return run

    try:
        outcome = runner(
            task=run.task,
            description=run.description,
            paths=paths,
            root=Path(run_root),
            gatherer=gatherer,
            model=run.model or "claude-opus-4-7",
            effort=run.effort,
        )
    except ClaudestructError as exc:
        run.status = RunStatus.failed.value
        run.error = str(exc)[:4096]
        run.ended_at = _now_utc()
        session.commit()
        log.warning("worker run %s failed: %s", run.run_id, run.error)
        return run
    except Exception as exc:  # pragma: no cover — last-ditch safety net
        run.status = RunStatus.failed.value
        run.error = f"{type(exc).__name__}: {exc}"[:4096]
        run.ended_at = _now_utc()
        session.commit()
        log.exception("worker run %s crashed", run.run_id)
        return run

    run.status = RunStatus.done.value
    run.cost_usd = outcome.cost_usd
    run.input_tokens = outcome.result.input_tokens
    run.output_tokens = outcome.result.output_tokens
    run.cache_read_tokens = outcome.result.cache_read_tokens
    run.cache_creation_tokens = outcome.result.cache_creation_tokens
    run.duration_ms = outcome.duration_ms
    run.ended_at = _now_utc()
    session.commit()
    log.info("worker run %s done: cost=$%.4f", run.run_id, run.cost_usd)
    return run


class WorkerThread:
    """Long-running daemon thread that keeps draining the queue.

    Sleeps ``poll_interval_s`` when the queue is empty so the DB
    isn't hammered. ``stop()`` flips a flag; the thread exits at
    the next sleep boundary, which is the safe way to interrupt
    a sync runner without hard-killing an in-flight call.
    """

    def __init__(
        self,
        *,
        run_root: str | Path,
        session_factory: Callable[[], Session],
        poll_interval_s: float = 1.0,
        runner: Callable[..., Any] = run_task_and_log,
    ) -> None:
        self.run_root = run_root
        self.session_factory = session_factory
        self.poll_interval_s = poll_interval_s
        self._runner = runner
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        if self._thread is not None and self._thread.is_alive():
            return
        self._stop.clear()
        t = threading.Thread(
            target=self._loop,
            name="claudestruct-worker",
            daemon=True,
        )
        self._thread = t
        t.start()

    def stop(self, timeout: float | None = 30.0) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=timeout)

    def _loop(self) -> None:
        while not self._stop.is_set():
            try:
                with self.session_factory() as session:
                    processed = process_pending_run(
                        session, self.run_root, runner=self._runner,
                    )
            except Exception:  # pragma: no cover — DB error
                log.exception("worker loop iteration crashed; sleeping then retry")
                processed = None
            if processed is None:
                # Queue empty — sleep before polling again. Use the
                # event so stop() can wake us promptly.
                self._stop.wait(timeout=self.poll_interval_s)


def drain_queue(
    session_factory: Callable[[], Session],
    run_root: str | Path,
    *,
    max_iterations: int = 1000,
    runner: Callable[..., Any] = run_task_and_log,
) -> int:
    """Drain every currently-queued run, return the count processed.

    Used by ``cs serve worker --once`` for cron / batch-style operation
    where a long-running thread is wrong. Bounded by ``max_iterations``
    as a safety net against an infinite re-queue loop.
    """
    processed = 0
    for _ in range(max_iterations):
        with session_factory() as session:
            row = process_pending_run(session, run_root, runner=runner)
        if row is None:
            break
        processed += 1
    return processed


# Convenience: tests sometimes want to wait for the worker to clear
# its queue without sleeping a fixed duration. This polls the row count.

def wait_until_empty(
    session_factory: Callable[[], Session],
    *,
    timeout_s: float = 30.0,
    poll_s: float = 0.05,
) -> bool:
    """Block until the queued+running set is empty or timeout. Returns
    True if drained, False on timeout."""
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        with session_factory() as session:
            n = session.execute(
                select(Run.id).where(
                    Run.status.in_([RunStatus.queued.value, RunStatus.running.value])
                )
            ).all()
        if not n:
            return True
        time.sleep(poll_s)
    return False
