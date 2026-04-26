"""Cumulative budget endpoint. Defaults the cap to env if unset."""
from __future__ import annotations

import os
from pathlib import Path

from fastapi import APIRouter, Depends, Query, Request

from claudestruct import budget as budget_mod
from claudestruct.server import auth as auth_mod
from claudestruct.server.models import Role
from claudestruct.server.schema import BudgetResponse

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
