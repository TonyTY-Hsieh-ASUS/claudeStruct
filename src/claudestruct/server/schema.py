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


# --- Shared / team dashboard (W6.5) ---------------------------------

class AuthorRollup(BaseModel):
    """Per-author aggregate for the leaderboard."""

    user_id: int
    email: str
    runs: int
    cost_usd: float
    input_tokens: int
    output_tokens: int


class TaskRollup(BaseModel):
    """Per-task aggregate for the donut chart."""

    task: str
    runs: int
    cost_usd: float


class TeamDashboardResponse(BaseModel):
    """Org-scoped rollup of recent runs.

    Authoritative numbers come from the `runs` table (W6.1) so legacy
    JSONL data isn't mixed in — the dashboard is meant to reflect what
    the daemon has actually executed for this org.
    """

    org_id: int
    org_slug: str
    total_runs: int
    total_cost_usd: float
    by_author: list[AuthorRollup]
    by_task: list[TaskRollup]
    recent: list[RunRow]


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
        "Run is queued. The daemon-mode worker (W6.1) picks it up and "
        "writes results back to the same row; poll GET /v1/runs/{id} "
        "for status. Run `cs serve worker` to drain the queue locally."
    )


class RunDetail(RunRow):
    pass


# --- Audit log (W8.4) ----------------------------------------------

class AuditHeadResponse(BaseModel):
    """Latest seq + entry_hash. seq=0 means the chain is empty and
    entry_hash is the genesis sentinel."""
    seq: int
    entry_hash: str


class AuditEntryResponse(BaseModel):
    seq: int
    action: str
    resource_type: str
    resource_id: str
    payload: Optional[object]
    actor_user_id: Optional[int]
    created_at: datetime
    prev_hash: str
    entry_hash: str


class AuditListResponse(BaseModel):
    entries: list[AuditEntryResponse]
    next_cursor_seq: Optional[int] = None


class AuditVerifyResponse(BaseModel):
    ok: bool
    total: int
    head_seq: Optional[int] = None
    head_hash: Optional[str] = None
    broken_at_seq: Optional[int] = None
    broken_reason: Optional[str] = None


# --- Billing (W8.2) ------------------------------------------------

class SandboxLimitsResponse(BaseModel):
    """Per-tier worker quotas surfaced via the subscription endpoint
    (W8.3). Lets the SPA / CLI render "you're 3/4 of your concurrent
    runs cap" without re-implementing the lookup table."""
    max_concurrent_runs: int
    max_runtime_seconds: int
    max_cost_usd: float


class SubscriptionResponse(BaseModel):
    """Org's current subscription state. ``tier`` defaults to "free"
    when no Subscription row exists yet."""
    org_slug: str
    tier: Literal["free", "team", "business"]
    status: Optional[str]  # mirrors Stripe: "active" / "past_due" / "canceled" / null
    stripe_customer_id: Optional[str]
    current_period_end: Optional[datetime]
    # W8.3: surface the active sandbox caps so callers don't have to
    # re-derive them from the tier name.
    sandbox_limits: SandboxLimitsResponse


class CheckoutRequest(BaseModel):
    tier: Literal["team", "business"]
    success_url: str = Field(min_length=8)
    cancel_url: str = Field(min_length=8)


class CheckoutResponse(BaseModel):
    """Stub: real Stripe Checkout integration ships when the merchant
    keys are available. The shape is pinned so the frontend can be
    written against it now."""
    checkout_session_id: str
    url: str
    note: str = (
        "Stripe checkout sessions are stubbed in the draft -- the route "
        "returns a deterministic placeholder URL until live merchant "
        "keys are provisioned."
    )


class UsageResponse(BaseModel):
    """Period-to-date token usage. Mirrors the budget endpoint shape
    so dashboards can render either with one renderer."""
    period_start: datetime
    period_end: datetime
    input_tokens: int
    output_tokens: int
    cache_read_tokens: int
    cache_creation_tokens: int
    cost_usd: float
