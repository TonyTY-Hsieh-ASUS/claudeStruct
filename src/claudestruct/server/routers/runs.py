"""Run submission + retrieval.

The draft accepts ``POST /v1/runs`` and returns 202 with a placeholder
run_id but does not actually execute the request — the worker model
arrives in W6.1 (daemon mode). ``GET /v1/runs/{id}`` reads the existing
JSONL log so historical runs are accessible immediately.
"""
from __future__ import annotations

import secrets
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy.orm import Session  # noqa: F401  (kept for follow-up W6.1 use)

from claudestruct import dashboard as dash_mod
from claudestruct.server import auth as auth_mod
from claudestruct.server.models import Role
from claudestruct.server.schema import (
    CreateRunRequest,
    CreateRunResponse,
    RunDetail,
)


router = APIRouter(prefix="/v1/runs", tags=["runs"])


@router.post(
    "",
    response_model=CreateRunResponse,
    status_code=status.HTTP_202_ACCEPTED,
)
def create_run(
    body: CreateRunRequest,  # noqa: ARG001  (shape pinned for W6.1)
    principal: auth_mod.Principal = Depends(auth_mod.require_role(Role.member)),
) -> CreateRunResponse:
    run_id = f"queued-{secrets.token_hex(6)}"
    return CreateRunResponse(run_id=run_id, status="queued")


@router.get("/{run_id}", response_model=RunDetail)
def get_run(
    run_id: str,
    request: Request,
    principal: auth_mod.Principal = Depends(auth_mod.require_role(Role.viewer)),
) -> RunDetail:
    root = Path(request.app.state.run_root)
    summaries = dash_mod.load_summaries(root)
    for s in summaries:
        if s.run_id == run_id:
            return RunDetail(
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
    raise HTTPException(status_code=404, detail="run not found")
