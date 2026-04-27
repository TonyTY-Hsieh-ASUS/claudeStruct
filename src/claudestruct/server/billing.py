"""Billing & subscription state (W8.2).

Open-core split:
- The :class:`Subscription` table + tier rules + usage rollup live
  in the OSS code (here) so self-hosters get the same bookkeeping.
- Live Stripe Checkout sessions + webhook signature verification
  ship behind the optional ``stripe`` PyPI dep — present only on
  the hosted control plane. The router stubs the real call when
  the dep is missing so the OSS daemon still serves a deterministic
  response.

Tiers (TODO.md W8.2):
    free      — 100k tokens/month, 90-day audit retention
    team      — usage-based ($N per million tokens)
    business  — usage + flat seat fee + 7-year audit retention

Webhook handling lives in the router because it needs the raw
request body for signature verification; the Stripe SDK reconstructs
the event from `(body, sig_header, webhook_secret)`.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from enum import Enum

from sqlalchemy import DateTime, ForeignKey, String, select
from sqlalchemy.orm import Mapped, Session, mapped_column

from claudestruct.server.db import Base


class Tier(str, Enum):
    free = "free"
    team = "team"
    business = "business"


def _now_utc() -> datetime:
    return datetime.now(timezone.utc)


# Audit retention policy per tier (days). Free tier rolls audit
# entries off after 90 days; paid tiers keep 7 years (per W8.4
# acceptance criteria). Pruning is enforced by a periodic worker
# (W6.1) reading these values.
AUDIT_RETENTION_DAYS: dict[Tier, int] = {
    Tier.free: 90,
    Tier.team: 365 * 7,
    Tier.business: 365 * 7,
}


# --- Tenant-scoped sandbox limits (W8.3) ----------------------------
#
# These caps gate the W6.1 worker. The worker reads them via
# ``sandbox_limits_for_org()``; an org over its concurrent limit is
# skipped (its rows stay queued and get picked up when a slot frees).
# Higher tiers also win priority via ``TIER_PRIORITY`` so a free-tier
# burst can't starve paying customers.
#
# Rationale for the numbers (revisit when we have telemetry):
#   - free: 1 concurrent run, 5 min wallclock, $0.50/run cost cap.
#     The cost cap matches `cs review`'s typical spend; it pushes
#     `cs plan --effort max` into the paid tiers.
#   - team: 4 concurrent runs, 15 min wallclock, $5/run.
#   - business: 16 concurrent runs, 60 min wallclock, $50/run.

class SandboxLimits:
    """Hard caps applied per run. Stored in code for now; if we ever
    want per-org overrides, this becomes a DB-backed lookup with the
    static table as the floor."""

    def __init__(
        self,
        *,
        max_concurrent_runs: int,
        max_runtime_seconds: int,
        max_cost_usd: float,
    ) -> None:
        self.max_concurrent_runs = max_concurrent_runs
        self.max_runtime_seconds = max_runtime_seconds
        self.max_cost_usd = max_cost_usd

    def as_dict(self) -> dict[str, int | float]:
        return {
            "max_concurrent_runs": self.max_concurrent_runs,
            "max_runtime_seconds": self.max_runtime_seconds,
            "max_cost_usd": self.max_cost_usd,
        }


SANDBOX_LIMITS: dict[Tier, SandboxLimits] = {
    Tier.free: SandboxLimits(
        max_concurrent_runs=1, max_runtime_seconds=300, max_cost_usd=0.5,
    ),
    Tier.team: SandboxLimits(
        max_concurrent_runs=4, max_runtime_seconds=900, max_cost_usd=5.0,
    ),
    Tier.business: SandboxLimits(
        max_concurrent_runs=16, max_runtime_seconds=3600, max_cost_usd=50.0,
    ),
}


# Higher number = picked first when the queue holds runs from
# multiple tiers simultaneously. business > team > free.
TIER_PRIORITY: dict[Tier, int] = {
    Tier.business: 30,
    Tier.team: 20,
    Tier.free: 10,
}


def sandbox_limits_for_tier(tier: str) -> SandboxLimits:
    """Look up the caps for a tier string. Falls back to free-tier on
    unknown values so a future tier name can't accidentally grant
    business-tier ceilings."""
    try:
        t = Tier(tier)
    except ValueError:
        t = Tier.free
    return SANDBOX_LIMITS.get(t, SANDBOX_LIMITS[Tier.free])


def tier_priority_for(tier: str) -> int:
    try:
        return TIER_PRIORITY[Tier(tier)]
    except (ValueError, KeyError):
        return TIER_PRIORITY[Tier.free]


class Subscription(Base):
    """One row per org. Created lazily on first checkout; the absence
    of a row means the org is on the free tier."""

    __tablename__ = "subscriptions"

    id: Mapped[int] = mapped_column(primary_key=True)
    org_id: Mapped[int] = mapped_column(
        ForeignKey("orgs.id", ondelete="CASCADE"),
        unique=True,
        index=True,
    )
    tier: Mapped[str] = mapped_column(String(16), default=Tier.free.value)
    # Stripe IDs are nullable for self-hosters that never connect a
    # billing account. The hosted control plane fills these in via
    # the checkout flow.
    stripe_customer_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    stripe_subscription_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    status: Mapped[str | None] = mapped_column(String(32), nullable=True)
    current_period_start: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    current_period_end: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_now_utc
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_now_utc, onupdate=_now_utc,
    )


def get_or_default(session: Session, org_id: int) -> Subscription:
    """Return the org's subscription row, materializing a free-tier
    placeholder if none exists. Caller commits if they want it
    persisted."""
    row = session.execute(
        select(Subscription).where(Subscription.org_id == org_id)
    ).scalar_one_or_none()
    if row is not None:
        return row
    placeholder = Subscription(org_id=org_id, tier=Tier.free.value)
    session.add(placeholder)
    session.flush()
    return placeholder


def current_period_bounds(
    sub: Subscription,
    *,
    now: datetime | None = None,
) -> tuple[datetime, datetime]:
    """Resolve the [start, end) window for usage queries.

    Paid orgs use the Stripe-provided `current_period_*` fields; free
    orgs (or paid orgs without Stripe state yet) fall back to the
    UTC calendar month so the dashboard never shows a blank window.
    """
    if sub.current_period_start and sub.current_period_end:
        return sub.current_period_start, sub.current_period_end
    n = (now or _now_utc()).astimezone(timezone.utc)
    start = n.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    if n.month == 12:
        end = start.replace(year=n.year + 1, month=1)
    else:
        end = start.replace(month=n.month + 1)
    return start, end


def stripe_sdk_available() -> bool:
    """True iff the optional `stripe` PyPI dep is installed.

    Imported eagerly here (fast attempt, immediately discarded) rather
    than every request — the result is stable for the process lifetime.
    """
    try:
        import stripe  # noqa: F401  type: ignore
        return True
    except ImportError:
        return False


def stub_checkout_url(*, org_slug: str, tier: Tier) -> tuple[str, str]:
    """Deterministic placeholder for the missing-Stripe path.

    Returns ``(session_id, url)``. The session ID is stable per
    ``(org, tier)`` so a frontend retrying the call sees the same
    response. Real merchant keys replace this with a `stripe.checkout.Session.create` call.
    """
    session_id = f"cs_test_{org_slug}_{tier.value}"
    url = f"https://checkout.example.invalid/{session_id}"
    return session_id, url


# --- Mock period state for the draft -------------------------------
#
# The real "current period token usage" answer comes from the W6.1
# daemon's run table summed against the subscription window. For the
# draft we expose the existing dashboard fold so an org can at least
# see its self-hosted JSONL spend through the same surface.

def free_tier_token_cap() -> int:
    """100k tokens / month for solo accounts (per TODO.md W8.2)."""
    return 100_000


def make_period_for_test(
    *,
    days: int = 30,
    now: datetime | None = None,
) -> tuple[datetime, datetime]:
    """Helper used by tests to fabricate a billing window without
    touching Stripe. Lives here so the production path doesn't have a
    test-only branch."""
    n = (now or _now_utc()).astimezone(timezone.utc)
    return n - timedelta(days=days), n
