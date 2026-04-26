"""Pydantic request/response shapes for the REST API.

Kept in one file because the surface is small. Each schema is the
public API contract — renaming fields here is a breaking change.
"""
from __future__ import annotations

from datetime import datetime
from typing import Literal, Optional

from pydantic import BaseModel, Field

# --- Health ---------------------------------------------------------

class HealthResponse(BaseModel):
    status: Literal["ok"] = "ok"
    version: str


# --- Auth / keys ----------------------------------------------------

class CreateKeyRequest(BaseModel):
    name: Optional[str] = Field(default=None, max_length=255)


class KeyMetadata(BaseModel):
    key_id: str
    name: Optional[str]
    created_at: datetime
    last_used_at: Optional[datetime]
    revoked_at: Optional[datetime]


class CreateKeyResponse(KeyMetadata):
    # Full secret is returned exactly once at creation; never again.
    full_key: str


class KeyList(BaseModel):
    keys: list[KeyMetadata]


# --- Dashboard ------------------------------------------------------

class RunRow(BaseModel):
    run_id: str
    started_at: Optional[str]
    ended_at: Optional[str]
    task: Optional[str]
    model: Optional[str]
    effort: Optional[str]
    reason: Optional[str]
    duration_ms: Optional[int]
    input_tokens: int
    output_tokens: int
    cache_read_tokens: int
    cache_creation_tokens: int
    cost_usd: float
    cache_warnings: list[str]


class DashboardResponse(BaseModel):
    runs: list[RunRow]


# --- Budget ---------------------------------------------------------

class BudgetResponse(BaseModel):
    spent_usd: float
    cap_usd: float
    warn_threshold_usd: float
    exceeded: bool
    near_limit: bool
    remaining_usd: float


# --- Runs (W6.1 will fill in execution semantics) -------------------

class CreateRunRequest(BaseModel):
    task: Literal["dev", "review", "plan", "debug"]
    description: str = Field(min_length=1)
    paths: list[str] = Field(default_factory=list)
    model: Optional[str] = None
    effort: Optional[Literal["low", "medium", "high", "xhigh", "max"]] = None
    max_tokens: Optional[int] = Field(default=None, ge=1)
    max_bytes: Optional[int] = Field(default=None, ge=1)


class CreateRunResponse(BaseModel):
    run_id: str
    status: Literal["queued"]
    note: str = (
        "Daemon-mode execution lands in W6.1; this draft accepts the "
        "request, returns a placeholder id, and does not run anything."
    )


class RunDetail(RunRow):
    pass
