"""Tests for `/v1/budget/team` (W6.5 — budget-cap team rollups).

The single-user `/v1/budget` view (W5.6) reads the JSONL store on
disk. The team view aggregates the multi-tenant `runs` table against
per-tier caps from billing.py. Both surfaces should be able to live
side-by-side; tests pin the team view's contract.
"""
from __future__ import annotations

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
from claudestruct.server.models import (
    ApiKey,
    Membership,
    Org,
    Role,
    Run,
    RunStatus,
    User,
)


@pytest.fixture()
def env(tmp_path):
    """Mirrors the fixture in test_billing.py — one org, three keys
    (admin/member/viewer), in-memory SQLite. Keeps the team-budget
    test surface independent of the billing test file's growth."""
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
            session.add(
                ApiKey(
                    user_id=user.id,
                    org_id=org.id,
                    key_id=key_id,
                    hashed_secret=hashed,
                    name=f"{email}-key",
                )
            )
            keys[email] = full
        session.commit()
    app = create_app(engine=engine, run_root=str(tmp_path), skip_init=True)
    return {
        "client": TestClient(app),
        "keys": keys,
        "factory": factory,
        "tmp_path": tmp_path,
    }


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _add_run(
    factory,
    *,
    org_slug: str,
    email: str,
    cost_usd: float,
    input_tokens: int = 0,
    output_tokens: int = 0,
    status: str = RunStatus.done.value,
    when: datetime | None = None,
) -> None:
    """Insert a Run row directly. Tests prefer this over hitting
    `POST /v1/runs` because that path queues + waits — we want to
    pin the rollup logic, not the worker."""
    when = when or datetime.now(timezone.utc).replace(day=15, hour=12)
    with factory() as session:
        org = session.query(Org).filter_by(slug=org_slug).one()
        user = session.query(User).filter_by(email=email).one()
        session.add(
            Run(
                run_id=f"run-{org.id}-{when.isoformat()}-{cost_usd}",
                org_id=org.id,
                user_id=user.id,
                status=status,
                task="review",
                description="d",
                cost_usd=cost_usd,
                input_tokens=input_tokens,
                output_tokens=output_tokens,
                created_at=when,
            )
        )
        session.commit()


# --- Tier USD caps -------------------------------------------------


def test_tier_usd_cap_known_tiers():
    assert billing_mod.tier_usd_cap("free") == 10.0
    assert billing_mod.tier_usd_cap("team") is None
    assert billing_mod.tier_usd_cap("business") is None


def test_tier_usd_cap_unknown_tier_falls_back_to_free():
    """Defensive: a misconfigured row mustn't accidentally grant
    business-tier ceilings."""
    assert billing_mod.tier_usd_cap("garbage") == 10.0
    assert billing_mod.tier_usd_cap(None) == 10.0


# --- current_period_cost ------------------------------------------


def test_current_period_cost_sums_done_and_failed_runs(env):
    factory = env["factory"]
    _add_run(factory, org_slug="acme", email="member@a", cost_usd=0.50)
    _add_run(factory, org_slug="acme", email="member@a", cost_usd=1.25)
    _add_run(
        factory,
        org_slug="acme",
        email="member@a",
        cost_usd=0.10,
        status=RunStatus.failed.value,
    )
    with factory() as s:
        org = s.query(Org).filter_by(slug="acme").one()
        assert billing_mod.current_period_cost(s, org.id) == pytest.approx(1.85)


def test_current_period_cost_excludes_queued_and_running(env):
    """Pre-completion rows have cost_usd=0 by default but should not
    be counted regardless — a future patch could land a `cost_usd`
    estimate on the queued row and the rollup must still ignore it."""
    factory = env["factory"]
    _add_run(
        factory,
        org_slug="acme",
        email="member@a",
        cost_usd=99.99,
        status=RunStatus.queued.value,
    )
    _add_run(
        factory,
        org_slug="acme",
        email="member@a",
        cost_usd=99.99,
        status=RunStatus.running.value,
    )
    _add_run(factory, org_slug="acme", email="member@a", cost_usd=2.00)
    with factory() as s:
        org = s.query(Org).filter_by(slug="acme").one()
        assert billing_mod.current_period_cost(s, org.id) == pytest.approx(2.00)


def test_current_period_cost_zero_for_empty_org(env):
    factory = env["factory"]
    with factory() as s:
        org = s.query(Org).filter_by(slug="acme").one()
        assert billing_mod.current_period_cost(s, org.id) == 0.0


# --- /v1/budget/team endpoint --------------------------------------


def test_team_budget_unauthenticated_401(env):
    r = env["client"].get("/v1/budget/team")
    assert r.status_code == 401


def test_team_budget_returns_free_tier_caps_for_new_org(env):
    r = env["client"].get("/v1/budget/team", headers=_auth(env["keys"]["viewer@a"]))
    assert r.status_code == 200
    body = r.json()
    assert body["org_slug"] == "acme"
    assert body["tier"] == "free"
    assert body["tokens_cap"] == 100_000
    assert body["cost_cap_usd"] == 10.0
    assert body["tokens_used"] == 0
    assert body["cost_used_usd"] == 0.0
    assert body["percent_used"] == 0.0
    assert body["near_limit"] is False
    assert body["exceeded"] is False


def test_team_budget_aggregates_runs(env):
    factory = env["factory"]
    _add_run(
        factory,
        org_slug="acme",
        email="member@a",
        cost_usd=2.00,
        input_tokens=10_000,
        output_tokens=5_000,
    )
    _add_run(
        factory,
        org_slug="acme",
        email="member@a",
        cost_usd=1.50,
        input_tokens=20_000,
        output_tokens=15_000,
    )
    r = env["client"].get(
        "/v1/budget/team", headers=_auth(env["keys"]["member@a"])
    )
    body = r.json()
    assert body["tokens_used"] == 50_000
    assert body["cost_used_usd"] == pytest.approx(3.50)
    # Highest of (50k/100k, 3.50/10) = max(0.5, 0.35) = 0.5
    assert body["percent_used"] == pytest.approx(0.5)
    assert body["near_limit"] is False
    assert body["exceeded"] is False


def test_team_budget_warns_at_80_percent(env):
    factory = env["factory"]
    # 85k / 100k tokens = 0.85, which crosses the 80 % warn line.
    _add_run(
        factory,
        org_slug="acme",
        email="member@a",
        cost_usd=1.00,
        input_tokens=85_000,
    )
    r = env["client"].get(
        "/v1/budget/team", headers=_auth(env["keys"]["viewer@a"])
    )
    body = r.json()
    assert body["near_limit"] is True
    assert body["exceeded"] is False
    assert body["percent_used"] >= 0.8


def test_team_budget_exceeded_when_over_cap(env):
    factory = env["factory"]
    # 110k tokens beats the 100k free-tier cap.
    _add_run(
        factory,
        org_slug="acme",
        email="member@a",
        cost_usd=2.00,
        input_tokens=110_000,
    )
    r = env["client"].get(
        "/v1/budget/team", headers=_auth(env["keys"]["viewer@a"])
    )
    body = r.json()
    assert body["exceeded"] is True
    # `near_limit` is the warn band, NOT a superset of `exceeded` —
    # locking that contract so frontends can paint amber vs. red
    # without double-classifying.
    assert body["near_limit"] is False
    assert body["percent_used"] >= 1.0


def test_team_budget_uncapped_tier_returns_none_caps(env):
    """A team-tier subscription has no monthly cap — the response
    should reflect that with `None` cap fields and `percent_used=0`."""
    factory = env["factory"]
    with factory() as session:
        org = session.query(Org).filter_by(slug="acme").one()
        sub = billing_mod.get_or_default(session, org.id)
        sub.tier = billing_mod.Tier.team.value
        session.commit()
    _add_run(
        factory,
        org_slug="acme",
        email="member@a",
        cost_usd=999.99,
        input_tokens=10_000_000,
    )
    r = env["client"].get(
        "/v1/budget/team", headers=_auth(env["keys"]["viewer@a"])
    )
    body = r.json()
    assert body["tier"] == "team"
    assert body["tokens_cap"] is None
    assert body["cost_cap_usd"] is None
    assert body["percent_used"] == 0.0
    assert body["near_limit"] is False
    assert body["exceeded"] is False


def test_team_budget_isolates_cross_org_runs(env):
    """Tenant isolation: runs from another org must not bleed into
    this org's rollup. Without RLS or an explicit org_id filter, this
    is the obvious bug; pin it."""
    factory = env["factory"]
    # Stand up a second org with a viewer + key.
    with factory() as session:
        other = Org(slug="rival", name="Rival")
        session.add(other)
        session.flush()
        u = User(email="viewer@rival")
        session.add(u)
        session.flush()
        session.add(Membership(user_id=u.id, org_id=other.id, role=Role.viewer.value))
        session.commit()
    _add_run(
        factory,
        org_slug="rival",
        email="viewer@rival",
        cost_usd=50.00,
        input_tokens=200_000,
    )
    # The acme caller must see 0 — rival's runs are theirs.
    r = env["client"].get(
        "/v1/budget/team", headers=_auth(env["keys"]["viewer@a"])
    )
    body = r.json()
    assert body["tokens_used"] == 0
    assert body["cost_used_usd"] == 0.0
