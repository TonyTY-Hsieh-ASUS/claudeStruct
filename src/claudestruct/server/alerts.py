"""Cost-regression detection (W6.5).

Folds the ``runs`` table per org and emits ``Alert`` rows for runs
whose ``cost_usd`` is more than ``sigma`` standard deviations above
the org's mean over a rolling lookback window.

Why mean+stddev (and not p99 / median absolute deviation):
- One number per org keeps the daemon's working set small.
- 2σ matches the convention operators expect from "regression"
  alerts in tools like Datadog / Honeycomb.
- We exclude failed runs (cost is still recorded for them but the
  partial work isn't comparable) — a single crashed run shouldn't
  push the baseline up enough to mask a real regression next time.

Edge cases:
- Orgs with < 3 successful runs in the window have no statistical
  baseline; skipped silently. Two data points can't yield a
  meaningful stddev.
- Stddev = 0 (all costs identical) → any non-zero deviation is
  flagged. This is rare in practice; matches Datadog behaviour.
- Only runs from the last ``check_recent_hours`` (default 24h) are
  candidates — we don't want a single old expensive run to fire an
  alert every time the cron runs.
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from claudestruct.server.models import Org, Run, RunStatus
from claudestruct.server.notify import Alert, Notifier

DEFAULT_SIGMA = 2.0
DEFAULT_LOOKBACK_DAYS = 30
DEFAULT_CHECK_RECENT_HOURS = 24
MIN_BASELINE_RUNS = 3


def _now_utc() -> datetime:
    return datetime.now(timezone.utc)


@dataclass(frozen=True)
class CostRegressionFinding:
    """One run flagged as regressing relative to its org baseline.

    Kept separate from ``Alert`` so the producer logic is testable
    without coupling to the notifier wire format."""
    org_id: int
    org_slug: str
    run_id: str
    run_cost_usd: float
    baseline_mean: float
    baseline_stddev: float
    sigma_above: float


def _stddev(samples: list[float], mean: float) -> float:
    """Population stddev. We use population (not sample) because we're
    describing the org's actual historical spend, not estimating an
    unknown distribution from a sample."""
    if len(samples) <= 1:
        return 0.0
    var = sum((x - mean) ** 2 for x in samples) / len(samples)
    return math.sqrt(var)


def compute_cost_regression_alerts(
    session: Session,
    *,
    sigma: float = DEFAULT_SIGMA,
    lookback_days: int = DEFAULT_LOOKBACK_DAYS,
    check_recent_hours: int = DEFAULT_CHECK_RECENT_HOURS,
    now: datetime | None = None,
) -> list[CostRegressionFinding]:
    """Fold the ``runs`` table and return one finding per regressing run.

    Caller is responsible for dispatching findings to a ``Notifier``
    via ``dispatch_findings`` — keeps the producer pure for tests.
    """
    n = (now or _now_utc()).astimezone(timezone.utc)
    baseline_cutoff = n - timedelta(days=lookback_days)
    recent_cutoff = n - timedelta(hours=check_recent_hours)

    rows: list[Run] = list(session.execute(
        select(Run).where(
            Run.status == RunStatus.done.value,
            Run.created_at >= baseline_cutoff,
        )
    ).scalars())

    # Group by org. Map of org_id → list[Run].
    by_org: dict[int, list[Run]] = {}
    for r in rows:
        by_org.setdefault(r.org_id, []).append(r)

    findings: list[CostRegressionFinding] = []
    for org_id, org_runs in by_org.items():
        if len(org_runs) < MIN_BASELINE_RUNS:
            # Insufficient baseline; skip silently.
            continue

        # Baseline = ALL successful runs in lookback (including the
        # recent ones). Excluding the recent ones would double-count
        # them as "outliers vs the past" every cron tick — an outlier
        # then becomes part of next tick's baseline naturally.
        costs = [float(r.cost_usd or 0.0) for r in org_runs]
        mean = sum(costs) / len(costs)
        stddev = _stddev(costs, mean)

        # Resolve org slug once per org (single row lookup, cheap).
        org_slug = ""
        org = session.get(Org, org_id)
        if org is not None:
            org_slug = org.slug

        for r in org_runs:
            if r.created_at is None:
                continue
            created = r.created_at
            if created.tzinfo is None:
                created = created.replace(tzinfo=timezone.utc)
            if created < recent_cutoff:
                continue
            cost = float(r.cost_usd or 0.0)
            # When stddev is 0, any deviation is "infinitely many σ" —
            # represent as a large finite value so downstream sorting
            # still works and the alert message is readable.
            if stddev == 0:
                if cost <= mean:
                    continue
                sigma_above = float("inf")
            else:
                sigma_above = (cost - mean) / stddev
            if sigma_above < sigma:
                continue
            findings.append(CostRegressionFinding(
                org_id=org_id,
                org_slug=org_slug,
                run_id=r.run_id,
                run_cost_usd=cost,
                baseline_mean=mean,
                baseline_stddev=stddev,
                sigma_above=sigma_above,
            ))

    # Stable sort — operator scanning a Slack channel sees the worst
    # regressions first. ``inf`` sorts to the top naturally.
    findings.sort(key=lambda f: f.sigma_above, reverse=True)
    return findings


def finding_to_alert(f: CostRegressionFinding) -> Alert:
    """Translate a producer finding into the wire-format ``Alert``.

    Severity ladder: ≥ 4σ is critical, ≥ 3σ is warning, otherwise info.
    Tuned so the default 2σ trigger threshold gives "info" rolls — the
    alert exists in the channel for trend-spotting but doesn't page
    anyone. Operators bump ``--sigma`` if they want fewer infos.
    """
    if f.sigma_above >= 4.0 or math.isinf(f.sigma_above):
        severity = "critical"
    elif f.sigma_above >= 3.0:
        severity = "warning"
    else:
        severity = "info"
    sigma_str = "∞" if math.isinf(f.sigma_above) else f"{f.sigma_above:.1f}"
    summary = (
        f"run {f.run_id} cost ${f.run_cost_usd:.2f} is {sigma_str}σ above "
        f"30d mean ${f.baseline_mean:.2f}"
    )
    return Alert(
        kind="cost_regression",
        severity=severity,
        org_slug=f.org_slug,
        summary=summary,
        details={
            "run_id": f.run_id,
            "run_cost_usd": round(f.run_cost_usd, 6),
            "baseline_mean_usd": round(f.baseline_mean, 6),
            "baseline_stddev_usd": round(f.baseline_stddev, 6),
            "sigma_above": (
                "inf" if math.isinf(f.sigma_above) else round(f.sigma_above, 3)
            ),
        },
    )


def dispatch_findings(
    findings: list[CostRegressionFinding],
    notifier: Notifier,
) -> int:
    """Convert findings → Alerts and hand each to the notifier.

    Returns the count dispatched so the CLI can echo "fired N alerts".
    The notifier's failure mode is its own concern — we don't catch
    here; ``LogNotifier`` can't fail and ``SlackWebhookNotifier``
    swallows HTTP errors itself with a log line.
    """
    count = 0
    for f in findings:
        notifier.notify(finding_to_alert(f))
        count += 1
    return count
