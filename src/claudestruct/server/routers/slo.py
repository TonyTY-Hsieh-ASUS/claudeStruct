"""Public SLO endpoint (W8.7).

Unauthenticated, like ``/healthz`` — designed for an external status
page (``status.claudestruct.dev``) to scrape without managing a service
token. The output is aggregate (no run IDs, no payloads, no
per-tenant data) so leaving it open trades nothing sensitive for
operator convenience.
"""
from __future__ import annotations

from fastapi import APIRouter, Request

from claudestruct.server import slo as slo_mod
from claudestruct.server.schema import (
    SloSnapshotResponse,
    SloTargetsResponse,
    SloWindow,
)

router = APIRouter(tags=["slo"])


@router.get("/v1/slo", response_model=SloSnapshotResponse)
def get_slo(request: Request) -> SloSnapshotResponse:
    factory = request.app.state.session_factory
    with factory() as session:
        snap = slo_mod.compute_snapshot(session)
    return SloSnapshotResponse(
        generated_at=snap.generated_at,
        targets=SloTargetsResponse(
            success_rate=snap.targets.success_rate,
            p95_run_start_ms=snap.targets.p95_run_start_ms,
            p95_duration_ms=snap.targets.p95_duration_ms,
        ),
        windows=[
            SloWindow(
                window=w.window,  # type: ignore[arg-type]
                total_runs=w.total_runs,
                succeeded=w.succeeded,
                failed=w.failed,
                success_rate=w.success_rate,
                error_rate=w.error_rate,
                p50_run_start_ms=w.p50_run_start_ms,
                p95_run_start_ms=w.p95_run_start_ms,
                p99_run_start_ms=w.p99_run_start_ms,
                p50_duration_ms=w.p50_duration_ms,
                p95_duration_ms=w.p95_duration_ms,
                p99_duration_ms=w.p99_duration_ms,
            )
            for w in snap.windows
        ],
    )
