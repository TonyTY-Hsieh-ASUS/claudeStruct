"""SLO snapshot computation (W8.7).

Produces the numbers powering ``GET /v1/slo`` and the public status
page. Folds the ``runs`` table (W6.1) over rolling windows (24h / 7d
/ 30d) into:

- ``total_runs`` — runs in a terminal state during the window.
- ``succeeded`` / ``failed`` — split of those terminal states.
- ``success_rate`` — ``succeeded / total_runs``; the closest analog to
  "uptime" we can derive from authentic data. Pure ``/healthz`` uptime
  needs an external prober and is documented as out-of-scope for the
  draft.
- ``run_start_latency_ms`` p50/p95/p99 — ``started_at - created_at``,
  i.e. time the request waited in the queue before a worker picked it
  up. This is what users feel as "I clicked Run, how long until it
  started?"
- ``duration_ms`` p50/p95/p99 — execution time for runs that reached
  ``done``. Failed runs are excluded so a single 30-second crash
  doesn't drag the percentiles around.

Targets live as module-level constants (not in the DB) so the SLO is
reviewed in code review, not silently mutated through a config table.

Design notes:

- Snapshot is global across all orgs. Per-tenant SLO is meaningful but
  needs a separate endpoint (and auth gate) — operators care about the
  fleet, individual orgs care about their own runs.
- The endpoint is unauthenticated like ``/healthz`` so an external
  status page can scrape it without managing a service token. The
  output is aggregate (no run IDs, no payloads) so this trades nothing
  sensitive for the operator convenience.
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from claudestruct.server.models import Run, RunStatus

# --- Targets --------------------------------------------------------

# Service-level objectives. Kept as plain constants because the SLO
# itself is a code-reviewed contract, not an ops dial. Bumping these
# requires intent (a PR) so a regression doesn't hide behind a config
# tweak.
SUCCESS_RATE_TARGET = 0.999  # 99.9% of executed runs reach `done`
P95_RUN_START_MS_TARGET = 5_000  # 5s p95 from queued → started
P95_DURATION_MS_TARGET = 600_000  # 10min p95 execution (advisory)


# Rolling windows the snapshot folds over. Order is preserved so the
# JSON keeps a stable shape.
WINDOWS_SECONDS: dict[str, int] = {
    "24h": 24 * 60 * 60,
    "7d": 7 * 24 * 60 * 60,
    "30d": 30 * 24 * 60 * 60,
}


def _now_utc() -> datetime:
    return datetime.now(timezone.utc)


def _as_aware(ts: datetime) -> datetime:
    """SQLite strips ``tzinfo`` on round-trip, so DB-loaded datetimes
    may come back naive. Force-attach UTC to keep arithmetic safe."""
    if ts.tzinfo is None:
        return ts.replace(tzinfo=timezone.utc)
    return ts


def _percentile(samples: list[int], pct: float) -> int | None:
    """Linear-interpolation percentile.

    Returns ``None`` for empty input so the JSON can carry an explicit
    ``null`` (vs ``0`` which would lie about an empty window). Matches
    the "nearest rank with linear interp" definition used by Prometheus
    histograms — close enough that operators reading both don't see
    drift between dashboards.
    """
    if not samples:
        return None
    if pct <= 0:
        return samples[0]
    if pct >= 100:
        return samples[-1]
    s = sorted(samples)
    rank = (pct / 100.0) * (len(s) - 1)
    lo = math.floor(rank)
    hi = math.ceil(rank)
    if lo == hi:
        return s[lo]
    frac = rank - lo
    return int(round(s[lo] + (s[hi] - s[lo]) * frac))


@dataclass(frozen=True)
class WindowSnapshot:
    """Per-window rollup. ``None`` for percentiles when the window is
    empty so consumers can render "n/a" instead of plotting a misleading
    zero."""
    window: str
    total_runs: int
    succeeded: int
    failed: int
    success_rate: float | None
    error_rate: float | None
    p50_run_start_ms: int | None
    p95_run_start_ms: int | None
    p99_run_start_ms: int | None
    p50_duration_ms: int | None
    p95_duration_ms: int | None
    p99_duration_ms: int | None


@dataclass(frozen=True)
class SloTargets:
    success_rate: float
    p95_run_start_ms: int
    p95_duration_ms: int


@dataclass(frozen=True)
class SloSnapshot:
    generated_at: datetime
    targets: SloTargets
    windows: list[WindowSnapshot]


def _window_snapshot(
    session: Session,
    *,
    name: str,
    now: datetime,
    window_seconds: int,
    org_id: int | None = None,
) -> WindowSnapshot:
    cutoff = now - timedelta(seconds=window_seconds)
    terminal = (RunStatus.done.value, RunStatus.failed.value)
    stmt = select(Run).where(Run.status.in_(terminal), Run.created_at >= cutoff)
    if org_id is not None:
        stmt = stmt.where(Run.org_id == org_id)
    rows: list[Run] = list(session.execute(stmt).scalars())

    total = len(rows)
    succeeded = sum(1 for r in rows if r.status == RunStatus.done.value)
    failed = total - succeeded
    if total == 0:
        success_rate: float | None = None
        error_rate: float | None = None
    else:
        success_rate = succeeded / total
        error_rate = failed / total

    # Run-start latency: created_at → started_at. Only rows that were
    # actually claimed contribute (``started_at`` non-null). A row that
    # failed before being claimed shouldn't tell us anything about
    # queue wait time.
    starts_ms: list[int] = []
    for r in rows:
        if r.started_at is None:
            continue
        delta = _as_aware(r.started_at) - _as_aware(r.created_at)
        # Negative deltas only happen with clock skew; clamp to 0 so
        # we don't poison the percentile with negatives.
        starts_ms.append(max(0, int(delta.total_seconds() * 1000)))

    # Execution duration: only for successful runs. A failed run's
    # ``duration_ms`` may reflect partial work / a crash and isn't
    # comparable to a healthy one's.
    duration_ms: list[int] = [
        int(r.duration_ms) for r in rows
        if r.status == RunStatus.done.value and r.duration_ms is not None
    ]

    return WindowSnapshot(
        window=name,
        total_runs=total,
        succeeded=succeeded,
        failed=failed,
        success_rate=success_rate,
        error_rate=error_rate,
        p50_run_start_ms=_percentile(starts_ms, 50),
        p95_run_start_ms=_percentile(starts_ms, 95),
        p99_run_start_ms=_percentile(starts_ms, 99),
        p50_duration_ms=_percentile(duration_ms, 50),
        p95_duration_ms=_percentile(duration_ms, 95),
        p99_duration_ms=_percentile(duration_ms, 99),
    )


def compute_snapshot(
    session: Session,
    *,
    now: datetime | None = None,
) -> SloSnapshot:
    """Fold the ``runs`` table into a fleet-wide SLO snapshot."""
    n = (now or _now_utc()).astimezone(timezone.utc)
    windows = [
        _window_snapshot(session, name=name, now=n, window_seconds=secs, org_id=None)
        for name, secs in WINDOWS_SECONDS.items()
    ]
    return SloSnapshot(
        generated_at=n,
        targets=SloTargets(
            success_rate=SUCCESS_RATE_TARGET,
            p95_run_start_ms=P95_RUN_START_MS_TARGET,
            p95_duration_ms=P95_DURATION_MS_TARGET,
        ),
        windows=windows,
    )


def compute_tenant_snapshot(
    session: Session,
    org_id: int,
    *,
    now: datetime | None = None,
) -> SloSnapshot:
    """Fold the ``runs`` table into a per-tenant SLO snapshot for *org_id*."""
    n = (now or _now_utc()).astimezone(timezone.utc)
    windows = [
        _window_snapshot(session, name=name, now=n, window_seconds=secs, org_id=org_id)
        for name, secs in WINDOWS_SECONDS.items()
    ]
    return SloSnapshot(
        generated_at=n,
        targets=SloTargets(
            success_rate=SUCCESS_RATE_TARGET,
            p95_run_start_ms=P95_RUN_START_MS_TARGET,
            p95_duration_ms=P95_DURATION_MS_TARGET,
        ),
        windows=windows,
    )
