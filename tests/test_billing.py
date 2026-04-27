"""Tests for the billing skeleton (W8.2).

Covers:
- Subscription model lifecycle (`get_or_default` materializes a free
  placeholder; subsequent calls return the same row)
- Tier-driven audit retention map
- ``current_period_bounds`` falls back to the UTC calendar month
- HTTP routes: ``GET /v1/billing/subscription``, ``POST /v1/billing/checkout``,
  ``GET /v1/billing/usage``, ``POST /v1/billing/webhook``
- Stripe SDK gating (webhook returns 503 when the SDK isn't installed)

The Stripe SDK is not installed in this test env -- ``stripe_sdk_available()``
returns False and the webhook path falls through to the 503 branch.
That's exactly the OSS self-host shape we want to ship.
"""
from __future__ import annotations

import json
from datetime import datetime, timezone

import pytest

pytest.importorskip("fastapi")
pytest.importorskip("sqlalchemy")
pytest.importorskip("pydantic")

from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.pool import StaticPool

from claudestruct.server import billing as billing_mod
from claudestruct.server.app import create_app
from claudestruct.server.auth import generate_key
from claudestruct.server.db import init_db, make_session_factory
from claudestruct.server.models import ApiKey, Membership, Org, Role, User


@pytest.fixture()
def env(tmp_path):
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    init_db(engine)
    factory = make_session_factory(engine)
    keys: dict[str, str] = {}
    with factory() as session:
        org = Org(slug="acme", name="Acme")
        session.add(org)
        session.flush()
        for email, role in [
            ("admin@a", Role.admin),
            ("member@a", Role.member),
            ("viewer@a", Role.viewer),
        ]:
            user = User(email=email)
            session.add(user)
            session.flush()
            session.add(Membership(user_id=user.id, org_id=org.id, role=role.value))
            full, key_id, hashed = generate_key()
            session.add(ApiKey(
                user_id=user.id, org_id=org.id,
                key_id=key_id, hashed_secret=hashed, name=f"{email}-key",
            ))
            keys[email] = full
        session.commit()
    app = create_app(engine=engine, run_root=str(tmp_path), skip_init=True)
    return {"client": TestClient(app), "keys": keys, "factory": factory,
            "tmp_path": tmp_path}


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


# --- Model + helpers ------------------------------------------------

def test_get_or_default_materializes_free_tier(env):
    factory = env["factory"]
    with factory() as session:
        org_id = session.query(Org).first().id
        sub = billing_mod.get_or_default(session, org_id)
        session.commit()
        assert sub.tier == billing_mod.Tier.free.value
        # Second call returns the same row, not a duplicate.
        sub2 = billing_mod.get_or_default(session, org_id)
        assert sub2.id == sub.id


def test_audit_retention_days_per_tier():
    assert billing_mod.AUDIT_RETENTION_DAYS[billing_mod.Tier.free] == 90
    assert billing_mod.AUDIT_RETENTION_DAYS[billing_mod.Tier.team] == 365 * 7
    assert billing_mod.AUDIT_RETENTION_DAYS[billing_mod.Tier.business] == 365 * 7


def test_current_period_bounds_uses_stripe_window_when_set():
    sub = billing_mod.Subscription(
        org_id=1,
        tier=billing_mod.Tier.team.value,
        current_period_start=datetime(2026, 4, 1, tzinfo=timezone.utc),
        current_period_end=datetime(2026, 5, 1, tzinfo=timezone.utc),
    )
    start, end = billing_mod.current_period_bounds(sub)
    assert start == datetime(2026, 4, 1, tzinfo=timezone.utc)
    assert end == datetime(2026, 5, 1, tzinfo=timezone.utc)


def test_current_period_bounds_falls_back_to_calendar_month():
    sub = billing_mod.Subscription(
        org_id=1, tier=billing_mod.Tier.free.value,
    )
    now = datetime(2026, 4, 15, 10, 30, tzinfo=timezone.utc)
    start, end = billing_mod.current_period_bounds(sub, now=now)
    assert start == datetime(2026, 4, 1, tzinfo=timezone.utc)
    assert end == datetime(2026, 5, 1, tzinfo=timezone.utc)


def test_calendar_month_handles_december_rollover():
    sub = billing_mod.Subscription(org_id=1, tier=billing_mod.Tier.free.value)
    now = datetime(2026, 12, 20, tzinfo=timezone.utc)
    start, end = billing_mod.current_period_bounds(sub, now=now)
    assert start == datetime(2026, 12, 1, tzinfo=timezone.utc)
    assert end == datetime(2027, 1, 1, tzinfo=timezone.utc)


def test_stub_checkout_url_is_deterministic():
    a = billing_mod.stub_checkout_url(org_slug="acme", tier=billing_mod.Tier.team)
    b = billing_mod.stub_checkout_url(org_slug="acme", tier=billing_mod.Tier.team)
    assert a == b
    c = billing_mod.stub_checkout_url(org_slug="acme", tier=billing_mod.Tier.business)
    assert c != a


# --- HTTP routes ----------------------------------------------------

def test_subscription_unauthenticated_401(env):
    r = env["client"].get("/v1/billing/subscription")
    assert r.status_code == 401


def test_subscription_returns_free_tier_for_new_org(env):
    r = env["client"].get(
        "/v1/billing/subscription", headers=_auth(env["keys"]["member@a"]),
    )
    assert r.status_code == 200
    body = r.json()
    assert body["tier"] == "free"
    assert body["org_slug"] == "acme"
    assert body["status"] is None
    assert body["stripe_customer_id"] is None


def test_subscription_member_can_read_admin_can_too(env):
    for email in ("member@a", "admin@a"):
        r = env["client"].get(
            "/v1/billing/subscription", headers=_auth(env["keys"][email]),
        )
        assert r.status_code == 200, email


def test_checkout_admin_only(env):
    r = env["client"].post(
        "/v1/billing/checkout",
        json={"tier": "team", "success_url": "https://example.com/ok",
              "cancel_url": "https://example.com/cancel"},
        headers=_auth(env["keys"]["member@a"]),
    )
    assert r.status_code == 403


def test_checkout_returns_stub_url(env):
    r = env["client"].post(
        "/v1/billing/checkout",
        json={"tier": "team", "success_url": "https://example.com/ok",
              "cancel_url": "https://example.com/cancel"},
        headers=_auth(env["keys"]["admin@a"]),
    )
    assert r.status_code == 201
    body = r.json()
    assert body["url"].startswith("https://checkout.example.invalid/")
    assert body["checkout_session_id"]


def test_checkout_audited(env):
    headers = _auth(env["keys"]["admin@a"])
    env["client"].post(
        "/v1/billing/checkout",
        json={"tier": "team", "success_url": "https://example.com/ok",
              "cancel_url": "https://example.com/cancel"},
        headers=headers,
    )
    listed = env["client"].get("/v1/audit", headers=headers).json()
    actions = [e["action"] for e in listed["entries"]]
    assert "billing.checkout.create" in actions


def test_usage_returns_zero_for_empty_run_log(env):
    r = env["client"].get(
        "/v1/billing/usage", headers=_auth(env["keys"]["member@a"]),
    )
    assert r.status_code == 200
    body = r.json()
    assert body["input_tokens"] == 0
    assert body["output_tokens"] == 0
    assert body["cost_usd"] == 0


def test_usage_aggregates_runs_in_current_period(env):
    runs_dir = env["tmp_path"] / ".claudestruct" / "runs"
    runs_dir.mkdir(parents=True)
    now = datetime.now(timezone.utc).replace(day=15, hour=12, minute=0, second=0, microsecond=0)
    (runs_dir / "r1.jsonl").write_text(
        "\n".join([
            json.dumps({"type": "run.start", "ts": now.isoformat(),
                        "task": "dev", "model": "claude-opus-4-7",
                        "effort": "high", "promptVersion": "v=abc"}),
            json.dumps({"type": "agent.usage", "inputTokens": 1234,
                        "outputTokens": 567, "cacheReadTokens": 100,
                        "cacheCreationTokens": 50, "costUsd": 1.50}),
            json.dumps({"type": "run.end", "ts": now.isoformat(),
                        "reason": "complete", "durationMs": 60000,
                        "totalCostUsd": 1.50}),
        ]),
        encoding="utf-8",
    )
    r = env["client"].get("/v1/billing/usage", headers=_auth(env["keys"]["member@a"]))
    assert r.status_code == 200
    body = r.json()
    assert body["input_tokens"] == 1234
    assert body["output_tokens"] == 567
    assert body["cost_usd"] == pytest.approx(1.50)


def test_webhook_503_when_stripe_not_installed(env):
    # In the test env, stripe SDK is not installed -- the route returns
    # 503 with a clear "install stripe" message.
    r = env["client"].post(
        "/v1/billing/webhook",
        headers={"Stripe-Signature": "t=0,v1=fake"},
        content=b"{}",
    )
    assert r.status_code == 503
    assert "stripe" in r.json()["detail"].lower()


def test_free_tier_token_cap():
    assert billing_mod.free_tier_token_cap() == 100_000


def test_subscription_endpoint_does_not_require_admin(env):
    """Members should be able to see their own org's billing state."""
    r = env["client"].get(
        "/v1/billing/subscription", headers=_auth(env["keys"]["viewer@a"]),
    )
    assert r.status_code == 200
