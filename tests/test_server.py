"""Tests for the daemon-mode REST API + RBAC (W6.2 + W6.3).

Covers:
- Health endpoints unauthenticated
- Bearer-token auth: missing / malformed / unknown / revoked / valid
- RBAC: viewer can read but not POST runs; admin can manage keys
- Route shapes for dashboard, budget, runs (read), runs (POST stub)
- Multi-tenant isolation: org A can't see org B's keys
"""
from __future__ import annotations

import json

import pytest

# Skip the whole module when the [server] extras aren't installed —
# keeps the lean-install CI matrix green.
pytest.importorskip("fastapi")
pytest.importorskip("sqlalchemy")
pytest.importorskip("pydantic")

from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.pool import StaticPool

from claudestruct.server.app import create_app
from claudestruct.server.auth import generate_key
from claudestruct.server.db import init_db, make_session_factory
from claudestruct.server.models import ApiKey, Membership, Org, Role, User


@pytest.fixture()
def env(tmp_path):
    """Per-test in-memory SQLite + temp run_root.

    Returns a dict with the app, TestClient, and a helper that mints
    keys for the canonical (org, user, role) combinations.
    """
    # StaticPool keeps a single connection so the in-memory DB is shared
    # between the seed transaction here and the FastAPI request handlers.
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    init_db(engine)
    factory = make_session_factory(engine)

    # Seed two orgs + four users (admin, member, viewer in org-a; admin in org-b).
    keys: dict[str, str] = {}
    with factory() as session:
        org_a = Org(slug="org-a", name="Org A")
        org_b = Org(slug="org-b", name="Org B")
        session.add_all([org_a, org_b])
        session.flush()

        users = {
            "admin@a": (org_a, Role.admin),
            "member@a": (org_a, Role.member),
            "viewer@a": (org_a, Role.viewer),
            "admin@b": (org_b, Role.admin),
        }
        for email, (org, role) in users.items():
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
    client = TestClient(app)

    return {"app": app, "client": client, "keys": keys, "tmp_path": tmp_path,
            "factory": factory}


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


# --- Health ---------------------------------------------------------

def test_healthz_unauthenticated(env):
    r = env["client"].get("/healthz")
    assert r.status_code == 200
    assert r.json()["status"] == "ok"
    assert "version" in r.json()


def test_readyz_unauthenticated(env):
    r = env["client"].get("/readyz")
    assert r.status_code == 200


# --- Auth gate ------------------------------------------------------

def test_dashboard_without_token_401(env):
    r = env["client"].get("/v1/dashboard")
    assert r.status_code == 401


def test_dashboard_with_malformed_token_401(env):
    r = env["client"].get("/v1/dashboard", headers=_auth("not-a-real-key"))
    assert r.status_code == 401


def test_dashboard_with_unknown_key_401(env):
    # Right shape, wrong key.
    r = env["client"].get("/v1/dashboard",
                          headers=_auth("ck_deadbeef_cafebabecafebabecafebabe"))
    assert r.status_code == 401


def test_dashboard_with_valid_viewer_key_200(env):
    r = env["client"].get("/v1/dashboard", headers=_auth(env["keys"]["viewer@a"]))
    assert r.status_code == 200
    assert r.json() == {"runs": []}


def test_revoked_key_rejected(env):
    # Revoke admin@a's key, then try to use it.
    factory = env["factory"]
    with factory() as session:
        from datetime import datetime, timezone

        from sqlalchemy import update
        session.execute(
            update(ApiKey).where(ApiKey.name == "admin@a-key").values(revoked_at=datetime.now(timezone.utc))
        )
        session.commit()
    r = env["client"].get("/v1/dashboard", headers=_auth(env["keys"]["admin@a"]))
    assert r.status_code == 401


# --- RBAC -----------------------------------------------------------

def test_viewer_cannot_create_run(env):
    r = env["client"].post(
        "/v1/runs",
        json={"task": "dev", "description": "hi"},
        headers=_auth(env["keys"]["viewer@a"]),
    )
    assert r.status_code == 403


def test_member_can_create_run(env):
    r = env["client"].post(
        "/v1/runs",
        json={"task": "dev", "description": "hi"},
        headers=_auth(env["keys"]["member@a"]),
    )
    assert r.status_code == 202
    body = r.json()
    assert body["status"] == "queued"
    assert body["run_id"].startswith("queued-")


def test_member_cannot_manage_keys(env):
    r = env["client"].get("/v1/keys", headers=_auth(env["keys"]["member@a"]))
    assert r.status_code == 403


def test_admin_can_create_and_revoke_key(env):
    headers = _auth(env["keys"]["admin@a"])
    create = env["client"].post("/v1/keys", json={"name": "ci-runner"}, headers=headers)
    assert create.status_code == 201
    body = create.json()
    assert body["full_key"].startswith("ck_")
    assert body["key_id"]
    new_key = body["full_key"]

    listed = env["client"].get("/v1/keys", headers=headers)
    assert listed.status_code == 200
    assert any(k["key_id"] == body["key_id"] for k in listed.json()["keys"])

    # The minted key authenticates as admin too.
    self_check = env["client"].get("/v1/dashboard", headers=_auth(new_key))
    assert self_check.status_code == 200

    revoke = env["client"].delete(f"/v1/keys/{body['key_id']}", headers=headers)
    assert revoke.status_code == 204

    # After revoke, the new key no longer works.
    after = env["client"].get("/v1/dashboard", headers=_auth(new_key))
    assert after.status_code == 401


# --- Multi-tenant isolation -----------------------------------------

def test_admin_b_cannot_revoke_admin_a_key(env):
    factory = env["factory"]
    # Find admin@a's key id
    with factory() as session:
        from sqlalchemy import select
        kid = session.execute(
            select(ApiKey.key_id).where(ApiKey.name == "admin@a-key")
        ).scalar_one()
    r = env["client"].delete(
        f"/v1/keys/{kid}",
        headers=_auth(env["keys"]["admin@b"]),
    )
    assert r.status_code == 404  # cross-tenant lookup returns "not found"


def test_admin_b_keys_list_excludes_org_a(env):
    r = env["client"].get("/v1/keys", headers=_auth(env["keys"]["admin@b"]))
    assert r.status_code == 200
    keys = r.json()["keys"]
    assert all("@a" not in (k.get("name") or "") for k in keys)


# --- Dashboard / budget shape ---------------------------------------

def test_dashboard_includes_seeded_run(env):
    runs_dir = env["tmp_path"] / ".claudestruct" / "runs"
    runs_dir.mkdir(parents=True)
    (runs_dir / "r1.jsonl").write_text(
        "\n".join([
            json.dumps({"type": "run.start", "ts": "2026-04-15T10:00:00+00:00",
                        "task": "dev", "model": "claude-opus-4-7",
                        "effort": "high", "promptVersion": "dev v=abc"}),
            json.dumps({"type": "agent.usage", "inputTokens": 100,
                        "outputTokens": 50, "costUsd": 1.25}),
            json.dumps({"type": "run.end", "ts": "2026-04-15T10:01:00+00:00",
                        "reason": "complete", "durationMs": 60000,
                        "totalCostUsd": 1.25}),
        ]),
        encoding="utf-8",
    )
    r = env["client"].get("/v1/dashboard", headers=_auth(env["keys"]["viewer@a"]))
    assert r.status_code == 200
    runs = r.json()["runs"]
    assert len(runs) == 1
    assert runs[0]["run_id"] == "r1"
    assert runs[0]["cost_usd"] == 1.25


def test_budget_disabled_returns_zero_cap(env):
    r = env["client"].get("/v1/budget", headers=_auth(env["keys"]["viewer@a"]))
    assert r.status_code == 200
    body = r.json()
    assert body["cap_usd"] == 0.0
    assert body["exceeded"] is False
    assert body["near_limit"] is False


def test_budget_with_query_cap(env):
    r = env["client"].get(
        "/v1/budget?cap_usd=100",
        headers=_auth(env["keys"]["viewer@a"]),
    )
    assert r.status_code == 200
    assert r.json()["cap_usd"] == 100.0


def test_get_unknown_run_404(env):
    r = env["client"].get("/v1/runs/nope", headers=_auth(env["keys"]["viewer@a"]))
    assert r.status_code == 404


# --- OpenAPI spec ---------------------------------------------------

def test_openapi_lists_v1_endpoints(env):
    r = env["client"].get("/openapi.json")
    assert r.status_code == 200
    spec = r.json()
    paths = set(spec["paths"].keys())
    assert "/v1/dashboard" in paths
    assert "/v1/budget" in paths
    assert "/v1/runs" in paths
    assert "/v1/keys" in paths
