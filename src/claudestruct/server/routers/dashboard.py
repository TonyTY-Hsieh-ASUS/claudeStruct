"""Read-only dashboard endpoint. Reuses the existing fold from
``claudestruct.dashboard`` so the JSONL contract stays single-sourced."""
from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, Depends, Request

from claudestruct import dashboard as dash_mod
from claudestruct.server import auth as auth_mod
from claudestruct.server.models import Role
from claudestruct.server.schema import DashboardResponse, RunRow


router = APIRouter(prefix="/v1", tags=["dashboard"])


def _resolve_root(request: Request) -> Path:
    """Project root that the daemon reads from. Set on
    ``app.state.run_root`` by the app factory."""
    return Path(request.app.state.run_root)


@router.get("/dashboard", response_model=DashboardResponse)
def get_dashboard(
    request: Request,
    principal: auth_mod.Principal = Depends(auth_mod.require_role(Role.viewer)),
) -> DashboardResponse:
    summaries = dash_mod.load_summaries(_resolve_root(request))
    rows = [
        RunRow(
            run_id=s.run_id,
            started_at=s.started_at,
            ended_at=s.ended_at,
            task=s.task,
            model=s.model,
            effort=s.effort,
            reason=s.reason,
            duration_ms=s.duration_ms,
            input_tokens=s.input_tokens,
            output_tokens=s.output_tokens,
            cache_read_tokens=s.cache_read_tokens,
            cache_creation_tokens=s.cache_creation_tokens,
            cost_usd=round(s.cost_usd, 6),
            cache_warnings=s.cache_warnings,
        )
        for s in summaries
    ]
    return DashboardResponse(runs=rows)
