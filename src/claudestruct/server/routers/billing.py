"""Billing routes (W8.2).

Three endpoints, all admin-only except the read-only subscription view:

- ``GET  /v1/billing/subscription``   member+ — current tier + Stripe state
- ``POST /v1/billing/checkout``       admin — create a Stripe Checkout session
- ``GET  /v1/billing/usage``          member+ — period-to-date token usage
- ``POST /v1/billing/webhook``        unauthenticated — Stripe webhook receiver

The webhook intentionally lives off the bearer-auth path: Stripe
signs each delivery with a shared secret and we verify the signature
manually. The webhook secret is read from the
``STRIPE_WEBHOOK_SECRET`` env var via :mod:`claudestruct.secrets`.

Stripe SDK is **lazy-imported**. When it's not installed (the OSS
self-host path), checkout returns a deterministic placeholder URL
and the webhook returns 503 with a clear "Stripe not configured"
message rather than 500.
"""
from __future__ import annotations

from datetime import datetime
from pathlib import Path

from fastapi import APIRouter, Depends, Header, HTTPException, Request, status
from sqlalchemy.orm import Session

from claudestruct import dashboard as dash_mod
from claudestruct import secrets as secrets_mod
from claudestruct.server import audit as audit_mod
from claudestruct.server import auth as auth_mod
from claudestruct.server import billing as billing_mod
from claudestruct.server.models import Role
from claudestruct.server.schema import (
    CheckoutRequest,
    CheckoutResponse,
    SubscriptionResponse,
    UsageResponse,
)

router = APIRouter(prefix="/v1/billing", tags=["billing"])


@router.get("/subscription", response_model=SubscriptionResponse)
def get_subscription(
    principal: auth_mod.Principal = Depends(auth_mod.require_role(Role.viewer)),
    session: Session = Depends(auth_mod.get_session),
) -> SubscriptionResponse:
    sub = billing_mod.get_or_default(session, principal.org_id)
    session.commit()
    limits = billing_mod.sandbox_limits_for_tier(sub.tier)
    from claudestruct.server.schema import SandboxLimitsResponse
    return SubscriptionResponse(
        org_slug=principal.org_slug,
        tier=billing_mod.Tier(sub.tier).value,  # type: ignore[arg-type]
        status=sub.status,
        stripe_customer_id=sub.stripe_customer_id,
        current_period_end=sub.current_period_end,
        sandbox_limits=SandboxLimitsResponse(**limits.as_dict()),
    )


@router.post(
    "/checkout",
    response_model=CheckoutResponse,
    status_code=status.HTTP_201_CREATED,
)
def create_checkout(
    body: CheckoutRequest,
    principal: auth_mod.Principal = Depends(auth_mod.require_role(Role.admin)),
    session: Session = Depends(auth_mod.get_session),
) -> CheckoutResponse:
    tier = billing_mod.Tier(body.tier)
    if billing_mod.stripe_sdk_available():
        # Real Stripe Checkout integration ships behind the
        # `claudestruct[hosted]` extra. The OSS path always falls
        # through to the stub so the route is testable end-to-end
        # without merchant keys in CI.
        session_id, url = billing_mod.stub_checkout_url(
            org_slug=principal.org_slug, tier=tier,
        )
    else:
        session_id, url = billing_mod.stub_checkout_url(
            org_slug=principal.org_slug, tier=tier,
        )
    audit_mod.record(
        session,
        org_id=principal.org_id,
        actor_user_id=principal.user_id,
        action="billing.checkout.create",
        resource_type="checkout_session",
        resource_id=session_id,
        payload={"tier": tier.value},
    )
    session.commit()
    return CheckoutResponse(checkout_session_id=session_id, url=url)


@router.get("/usage", response_model=UsageResponse)
def get_usage(
    request: Request,
    principal: auth_mod.Principal = Depends(auth_mod.require_role(Role.viewer)),
    session: Session = Depends(auth_mod.get_session),
) -> UsageResponse:
    sub = billing_mod.get_or_default(session, principal.org_id)
    period_start, period_end = billing_mod.current_period_bounds(sub)
    # In the draft we read from the JSONL store the same way the
    # dashboard does. W6.1's run table will replace this with a
    # tenant-scoped DB query.
    run_root = Path(request.app.state.run_root)
    summaries = dash_mod.load_summaries(run_root)
    in_tok = out_tok = cache_r = cache_c = 0
    cost = 0.0
    for s in summaries:
        if not s.started_at:
            continue
        try:
            ts = datetime.fromisoformat(s.started_at)
        except ValueError:
            continue
        if ts.tzinfo is None:
            from datetime import timezone as _tz

            ts = ts.replace(tzinfo=_tz.utc)
        if not (period_start <= ts < period_end):
            continue
        in_tok += s.input_tokens
        out_tok += s.output_tokens
        cache_r += s.cache_read_tokens
        cache_c += s.cache_creation_tokens
        cost += s.cost_usd
    session.commit()
    return UsageResponse(
        period_start=period_start,
        period_end=period_end,
        input_tokens=in_tok,
        output_tokens=out_tok,
        cache_read_tokens=cache_r,
        cache_creation_tokens=cache_c,
        cost_usd=round(cost, 6),
    )


@router.post("/webhook", status_code=status.HTTP_204_NO_CONTENT)
async def stripe_webhook(
    request: Request,
    stripe_signature: str | None = Header(default=None, alias="Stripe-Signature"),
    session: Session = Depends(auth_mod.get_session),
) -> None:
    if not billing_mod.stripe_sdk_available():
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=(
                "Stripe SDK not installed; install with `pip install stripe` "
                "to enable webhook handling."
            ),
        )
    secret = secrets_mod.get("stripe.webhook_secret")
    if not secret:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="STRIPE_WEBHOOK_SECRET not configured",
        )
    if stripe_signature is None:
        raise HTTPException(status_code=400, detail="missing Stripe-Signature header")
    raw = await request.body()
    import stripe  # type: ignore

    try:
        event = stripe.Webhook.construct_event(
            payload=raw,
            sig_header=stripe_signature,
            secret=secret,
        )
    except (stripe.SignatureVerificationError, ValueError) as exc:  # type: ignore[attr-defined]
        raise HTTPException(status_code=400, detail=f"invalid signature: {exc}") from exc

    # Minimal dispatcher: real handlers land alongside the live
    # checkout integration. For now we audit the receipt + ack.
    audit_mod.record(
        session,
        org_id=0,  # Stripe events aren't tied to a single org until we resolve customer_id
        actor_user_id=None,
        action=f"stripe.{event.get('type', 'unknown')}",
        resource_type="stripe_event",
        resource_id=str(event.get("id", "")),
        payload={"type": event.get("type")},
    )
    session.commit()
