"""Cumulative budget endpoint. Defaults the cap to env if unset.

Two surfaces:

- ``GET /v1/budget`` — single-user JSONL-store view (W5.6). Reads the
  daemon-host's `.claudestruct/runs/*.jsonl` and compares against the
  ``CLAUDESTRUCT_MONTHLY_CAP_USD`` env or the override query.
- ``GET /v1/budget/team`` — multi-tenant rollup (W6.5). Aggregates
  the caller's org's current-period tokens + cost from the ``runs``
  table and compares against the tier caps from billing.py. This is
  the cap that gates `POST /v1/runs` via ``_enforce_token_cap``.
"""
from __future__ import annotations

import os
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy import select

from claudestruct import budget as budget_mod
from claudestruct.server import auth as auth_mod
from claudestruct.server import billing as billing_mod
from claudestruct.server.models import Org, Role
from claudestruct.server.schema import BudgetResponse, TeamBudgetResponse

router = APIRouter(prefix="/v1", tags=["budget"])


def _default_cap() -> float:
    raw = os.environ.get("CLAUDESTRUCT_MONTHLY_CAP_USD")
    if not raw:
        return 0.0
    try:
        return float(raw)
    except ValueError:
        return 0.0


@router.get("/budget", response_model=BudgetResponse)
def get_budget(
    request: Request,
    cap_usd: float = Query(
        default=None,
        description=(
            "Override the cap to evaluate against. Defaults to "
            "CLAUDESTRUCT_MONTHLY_CAP_USD env or 0 (disabled)."
        ),
    ),
    principal: auth_mod.Principal = Depends(auth_mod.require_role(Role.viewer)),
) -> BudgetResponse:
    root = Path(request.app.state.run_root)
    effective_cap = cap_usd if cap_usd is not None else _default_cap()
    status = budget_mod.check_budget(root, effective_cap)
    return BudgetResponse(
        spent_usd=round(status.spent_usd, 6),
        cap_usd=status.cap_usd,
        warn_threshold_usd=status.warn_threshold_usd,
        exceeded=status.exceeded,
        near_limit=status.near_limit,
        remaining_usd=round(status.remaining_usd(), 6),
    )


# Same warn threshold the W5.6 single-user view uses (80 % of cap).
# Hoisted as a module constant so the team rollup stays consistent
# with what the per-user dashboard surfaces.
_NEAR_LIMIT_FRACTION = 0.8


def _percent_used(
    *,
    tokens_used: int,
    tokens_cap: int | None,
    cost_used_usd: float,
    cost_cap_usd: float | None,
) -> float:
    """Highest of the two ratios. Either cap missing → that side
    contributes 0; both missing → 0 (truly uncapped tier)."""
    ratios: list[float] = []
    if tokens_cap and tokens_cap > 0:
        ratios.append(tokens_used / tokens_cap)
    if cost_cap_usd and cost_cap_usd > 0:
        ratios.append(cost_used_usd / cost_cap_usd)
    return max(ratios) if ratios else 0.0


@router.get("/budget/team", response_model=TeamBudgetResponse)
def get_team_budget(
    request: Request,
    principal: auth_mod.Principal = Depends(auth_mod.require_role(Role.viewer)),
) -> TeamBudgetResponse:
    """Current-period token + cost rollup for the caller's org (W6.5).

    Compared against the tier caps from billing.py. When the org sits
    on a tier with no monthly cap (team / business), the cap fields
    return ``None`` and ``percent_used`` is 0 — frontends should render
    "uncapped" / hide the warning band.
    """
    factory = request.app.state.session_factory
    with factory() as session:
        org = session.execute(
            select(Org).where(Org.id == principal.org_id)
        ).scalar_one_or_none()
        if org is None:
            raise HTTPException(status_code=404, detail="org not found")

        sub = billing_mod.get_or_default(session, org.id)
        start, end = billing_mod.current_period_bounds(sub)

        tokens_used = billing_mod.current_period_token_usage(session, org.id)
        cost_used = billing_mod.current_period_cost(session, org.id)

        tokens_cap = billing_mod.tier_token_cap(sub.tier)
        cost_cap = billing_mod.tier_usd_cap(sub.tier)

        percent = _percent_used(
            tokens_used=tokens_used,
            tokens_cap=tokens_cap,
            cost_used_usd=cost_used,
            cost_cap_usd=cost_cap,
        )

        return TeamBudgetResponse(
            org_id=org.id,
            org_slug=org.slug,
            tier=sub.tier,
            period_start=start.isoformat(),
            period_end=end.isoformat(),
            tokens_used=tokens_used,
            tokens_cap=tokens_cap,
            cost_used_usd=round(cost_used, 6),
            cost_cap_usd=cost_cap,
            percent_used=round(percent, 4),
            near_limit=percent >= _NEAR_LIMIT_FRACTION and percent < 1.0,
            exceeded=percent >= 1.0,
        )
