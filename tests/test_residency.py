"""Tests for data residency tagging (W8.5).

Covers:
- ``resolve_region`` priority (override > env > default).
- ``RegionHeaderMiddleware`` stamps every response with ``X-CS-Region``.
- ``/healthz`` + ``/readyz`` echo the region in the body.
- ``Subscription.region`` field round-trips through the DB.
"""
from __future__ import annotations

import pytest

pytest.importorskip("fastapi")
pytest.importorskip("sqlalchemy")
pytest.importorskip("pydantic")

from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.pool import StaticPool

from claudestruct.server import app as app_mod
from claudestruct.server.app import create_app, resolve_region
from claudestruct.server.billing import Subscription
from claudestruct.server.db import init_db, make_session_factory


# --- resolve_region --------------------------------------------------

def test_resolve_region_explicit_override(monkeypatch):
    monkeypatch.setenv("CLAUDESTRUCT_REGION", "eu-west-1")
    assert resolve_region("ap-southeast-2") == "ap-southeast-2"


def test_resolve_region_env(monkeypatch):
    monkeypatch.setenv("CLAUDESTRUCT_REGION", "eu-west-1")
    assert resolve_region(None) == "eu-west-1"


def test_resolve_region_default_when_unset(monkeypatch):
    monkeypatch.delenv("CLAUDESTRUCT_REGION", raising=False)
    assert resolve_region(None) == app_mod.DEFAULT_REGION


# --- HTTP wiring -----------------------------------------------------

@pytest.fixture()
def env(tmp_path):
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    init_db(engine)
    factory = make_session_factory(engine)
    app = create_app(
        engine=engine, run_root=str(tmp_path), skip_init=True,
        region="eu-west-1",
    )
    return {"client": TestClient(app), "factory": factory, "app": app}


def test_app_state_records_region(env):
    assert env["app"].state.region == "eu-west-1"


def test_healthz_body_carries_region(env):
    r = env["client"].get("/healthz")
    assert r.status_code == 200
    assert r.json()["region"] == "eu-west-1"


def test_readyz_body_carries_region(env):
    r = env["client"].get("/readyz")
    assert r.status_code == 200
    assert r.json()["region"] == "eu-west-1"


def test_x_cs_region_header_on_every_response(env):
    """Every endpoint, authenticated or not, surfaces the region.
    Healthz is unauthenticated so we use it to verify the middleware
    runs even when the route never touches app.state.region."""
    for path in ["/healthz", "/readyz", "/openapi.json", "/v1/dashboard"]:
        r = env["client"].get(path)
        assert r.headers.get("X-CS-Region") == "eu-west-1", path


def test_region_default_when_app_built_without_kwarg(tmp_path, monkeypatch):
    monkeypatch.delenv("CLAUDESTRUCT_REGION", raising=False)
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    init_db(engine)
    app = create_app(engine=engine, run_root=str(tmp_path), skip_init=True)
    client = TestClient(app)
    r = client.get("/healthz")
    assert r.json()["region"] == app_mod.DEFAULT_REGION


# --- DB column round-trip --------------------------------------------

def test_subscription_region_column_round_trips(env):
    factory = env["factory"]
    with factory() as session:
        from claudestruct.server.models import Org

        org = Org(slug="acme", name="Acme")
        session.add(org)
        session.flush()
        sub = Subscription(org_id=org.id, tier="team", region="eu-west-1")
        session.add(sub)
        session.commit()

        from sqlalchemy import select

        loaded = session.execute(
            select(Subscription).where(Subscription.org_id == org.id)
        ).scalar_one()
        assert loaded.region == "eu-west-1"


def test_subscription_region_defaults_to_none(env):
    """Self-host orgs that don't set a residency pin keep region=None."""
    factory = env["factory"]
    with factory() as session:
        from claudestruct.server.models import Org

        org = Org(slug="acme2", name="Acme 2")
        session.add(org)
        session.flush()
        sub = Subscription(org_id=org.id, tier="free")
        session.add(sub)
        session.commit()

        from sqlalchemy import select

        loaded = session.execute(
            select(Subscription).where(Subscription.org_id == org.id)
        ).scalar_one()
        assert loaded.region is None


def test_subscription_wrapped_dek_columns_round_trip(env):
    factory = env["factory"]
    with factory() as session:
        from claudestruct.server.models import Org

        org = Org(slug="acme3", name="Acme 3")
        session.add(org)
        session.flush()
        sub = Subscription(
            org_id=org.id,
            tier="business",
            wrapped_dek_b64="abcdef",
            wrapped_dek_provider="local",
            wrapped_dek_key_id="local",
        )
        session.add(sub)
        session.commit()

        from sqlalchemy import select

        loaded = session.execute(
            select(Subscription).where(Subscription.org_id == org.id)
        ).scalar_one()
        assert loaded.wrapped_dek_b64 == "abcdef"
        assert loaded.wrapped_dek_provider == "local"
        assert loaded.wrapped_dek_key_id == "local"
