"""Health probes — unauthenticated, suitable for k8s liveness/readiness."""
from __future__ import annotations

from fastapi import APIRouter

from claudestruct import __version__
from claudestruct.server.schema import HealthResponse

router = APIRouter()


@router.get("/healthz", response_model=HealthResponse, tags=["health"])
def healthz() -> HealthResponse:
    return HealthResponse(version=__version__)


@router.get("/readyz", response_model=HealthResponse, tags=["health"])
def readyz() -> HealthResponse:
    # In the draft, ready == healthy. Once the daemon owns a queue
    # backlog (W6.1), readyz can degrade based on worker pool state.
    return HealthResponse(version=__version__)
