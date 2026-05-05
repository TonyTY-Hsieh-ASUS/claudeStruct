"""Health probes — unauthenticated, suitable for k8s liveness/readiness."""
from __future__ import annotations

from fastapi import APIRouter, Request

from claudestruct import __version__
from claudestruct.server.schema import HealthResponse

router = APIRouter()


@router.get("/healthz", response_model=HealthResponse, tags=["health"])
def healthz(request: Request) -> HealthResponse:
    region = getattr(request.app.state, "region", None)
    return HealthResponse(version=__version__, region=region)


@router.get("/readyz", response_model=HealthResponse, tags=["health"])
def readyz(request: Request) -> HealthResponse:
    # In the draft, ready == healthy. Once the daemon owns a queue
    # backlog (W6.1), readyz can degrade based on worker pool state.
    region = getattr(request.app.state, "region", None)
    return HealthResponse(version=__version__, region=region)
