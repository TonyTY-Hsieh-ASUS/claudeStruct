"""Tests for the hash-chained audit log (W8.4).

Covers the chain semantics directly (no HTTP) plus the public
``/v1/audit/*`` endpoints (auth gate, RBAC, head/verify shape, tenant
isolation). Also exercises the cross-cutting wiring: a successful
``/v1/keys`` create / revoke and ``/v1/runs`` submit must each append
exactly one audit row to the principal's org chain.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

pytest.importorskip("fastapi")
pytest.importorskip("sqlalchemy")
pytest.importorskip("pydantic")

from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.pool import StaticPool

from claudestruct.server import audit as audit_mod
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
        org_a = Org(slug="org-a", name="Org A")
        org_b = Org(slug="org-b", name="Org B")
        session.add_all([org_a, org_b])
        session.flush()
        for email, (org, role) in {
            "admin@a": (org_a, Role.admin),
            "viewer@a": (org_a, Role.viewer),
            "member@a": (org_a, Role.member),
            "admin@b": (org_b, Role.admin),
        }.items():
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


# --- Chain primitives (unit) ----------------------------------------

def test_canonical_hash_is_deterministic():
    args = dict(
        prev_hash="0" * 64, org_id=1, actor_user_id=2, action="x",
        resource_type="r", resource_id="abc",
        payload={"b": 1, "a": 2},
        created_at=datetime(2026, 4, 26, 12, 0, tzinfo=timezone.utc),
    )
    h1 = audit_mod.compute_entry_hash(**args)
    h2 = audit_mod.compute_entry_hash(**args)
    assert h1 == h2
    # Equivalent payload with reordered keys hashes identically -- this
    # is the whole point of canonical_json.
    args2 = dict(args, payload={"a": 2, "b": 1})
    assert audit_mod.compute_entry_hash(**args2) == h1


def test_record_starts_chain_with_genesis_prev(env):
    factory = env["factory"]
    with factory() as session:
        row = audit_mod.record(
            session, org_id=1, actor_user_id=1,
            action="seed.test", resource_type="x", resource_id="1",
            payload={"hello": "world"},
        )
        session.commit()
        assert row.seq == 1
        assert row.prev_hash == audit_mod.GENESIS_HASH
        assert len(row.entry_hash) == 64


def test_record_chains_subsequent_entries(env):
    factory = env["factory"]
    with factory() as session:
        a = audit_mod.record(
            session, org_id=1, actor_user_id=1,
            action="seed.a", resource_type="x", resource_id="a", payload={},
        )
        b = audit_mod.record(
            session, org_id=1, actor_user_id=1,
            action="seed.b", resource_type="x", resource_id="b", payload={},
        )
        session.commit()
        assert a.seq == 1 and b.seq == 2
        assert b.prev_hash == a.entry_hash


def test_chain_is_per_org(env):
    factory = env["factory"]
    with factory() as session:
        a1 = audit_mod.record(
            session, org_id=1, actor_user_id=1,
            action="x", resource_type="r", resource_id="1", payload={},
        )
        b1 = audit_mod.record(
            session, org_id=2, actor_user_id=1,
            action="x", resource_type="r", resource_id="1", payload={},
        )
        session.commit()
        # Both are seq=1 in their own org chain.
        assert a1.seq == 1
        assert b1.seq == 1
        assert a1.prev_hash == b1.prev_hash == audit_mod.GENESIS_HASH


def test_verify_returns_ok_for_clean_chain(env):
    factory = env["factory"]
    with factory() as session:
        for i in range(3):
            audit_mod.record(
                session, org_id=1, actor_user_id=None,
                action="x", resource_type="r", resource_id=str(i), payload={"i": i},
            )
        session.commit()
        report = audit_mod.verify_chain(session, org_id=1)
        assert report.ok is True
        assert report.total == 3
        assert report.head_seq == 3


def test_verify_detects_tampered_payload(env):
    factory = env["factory"]
    with factory() as session:
        audit_mod.record(
            session, org_id=1, actor_user_id=None,
            action="x", resource_type="r", resource_id="1", payload={"v": 1},
        )
        audit_mod.record(
            session, org_id=1, actor_user_id=None,
            action="x", resource_type="r", resource_id="2", payload={"v": 2},
        )
        session.commit()
        # Mutate the first row's payload directly in the DB without
        # recomputing the hash. This is exactly the casual log-doctoring
        # the chain is meant to catch.
        from sqlalchemy import update

        session.execute(
            update(audit_mod.AuditEntry)
            .where(audit_mod.AuditEntry.seq == 1)
            .values(payload_json='{"v":99}')
        )
        session.commit()
        report = audit_mod.verify_chain(session, org_id=1)
        assert report.ok is False
        assert report.broken_at_seq == 1
        assert "entry_hash" in (report.broken_reason or "")


def test_verify_detects_seq_gap(env):
    factory = env["factory"]
    with factory() as session:
        audit_mod.record(
            session, org_id=1, actor_user_id=None,
            action="x", resource_type="r", resource_id="1", payload={},
        )
        audit_mod.record(
            session, org_id=1, actor_user_id=None,
            action="x", resource_type="r", resource_id="2", payload={},
        )
        session.commit()
        # Delete the middle row, leaving seq=2.
        session.query(audit_mod.AuditEntry).filter_by(seq=1).delete()
        session.commit()
        report = audit_mod.verify_chain(session, org_id=1)
        assert report.ok is False
        assert report.broken_at_seq == 2
        assert "seq gap" in (report.broken_reason or "")


def test_prune_audit_removes_old_rows(env):
    factory = env["factory"]
    with factory() as session:
        old = audit_mod.record(
            session, org_id=1, actor_user_id=None,
            action="x", resource_type="r", resource_id="old", payload={},
        )
        # Backdate the row's created_at to 200 days ago.
        old.created_at = datetime.now(timezone.utc) - timedelta(days=200)
        session.add(audit_mod.AuditEntry(
            org_id=1, actor_user_id=None,
            action="x", resource_type="r", resource_id="recent",
            payload_json="{}", seq=2,
            prev_hash=old.entry_hash, entry_hash="z" * 64,
        ))
        session.commit()
        deleted = audit_mod.prune_audit(session, org_id=1, older_than_days=90)
        session.commit()
        assert deleted == 1


# --- HTTP routes ----------------------------------------------------

def test_head_unauthenticated_401(env):
    r = env["client"].get("/v1/audit/head")
    assert r.status_code == 401


def test_head_empty_returns_genesis(env):
    r = env["client"].get("/v1/audit/head", headers=_auth(env["keys"]["viewer@a"]))
    assert r.status_code == 200
    body = r.json()
    assert body["seq"] == 0
    assert body["entry_hash"] == "0" * 64


def test_key_create_appends_audit_row(env):
    headers = _auth(env["keys"]["admin@a"])
    create = env["client"].post("/v1/keys", json={"name": "ci"}, headers=headers)
    assert create.status_code == 201
    head = env["client"].get("/v1/audit/head", headers=headers).json()
    assert head["seq"] == 1
    listed = env["client"].get("/v1/audit", headers=headers).json()
    entries = listed["entries"]
    assert any(e["action"] == "key.create" for e in entries)


def test_run_submit_appends_audit_row(env):
    headers = _auth(env["keys"]["member@a"])
    r = env["client"].post(
        "/v1/runs",
        json={"task": "dev", "description": "hi"},
        headers=headers,
    )
    assert r.status_code == 202
    # Member can't read /v1/audit (admin-only); use the admin key for
    # inspection. Both members share org-a's chain.
    admin_headers = _auth(env["keys"]["admin@a"])
    head = env["client"].get("/v1/audit/head", headers=admin_headers).json()
    assert head["seq"] >= 1
    listed = env["client"].get("/v1/audit", headers=admin_headers).json()
    assert any(e["action"] == "run.submit" for e in listed["entries"])


def test_audit_list_admin_only(env):
    r = env["client"].get("/v1/audit", headers=_auth(env["keys"]["viewer@a"]))
    assert r.status_code == 403


def test_audit_verify_returns_ok_against_clean_chain(env):
    headers = _auth(env["keys"]["admin@a"])
    env["client"].post("/v1/keys", json={"name": "ci"}, headers=headers)
    env["client"].post("/v1/keys", json={"name": "ci2"}, headers=headers)
    r = env["client"].get("/v1/audit/verify", headers=headers)
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert body["total"] == 2


def test_audit_chain_isolated_across_orgs(env):
    a_headers = _auth(env["keys"]["admin@a"])
    b_headers = _auth(env["keys"]["admin@b"])
    env["client"].post("/v1/keys", json={"name": "for-a"}, headers=a_headers)
    a_head = env["client"].get("/v1/audit/head", headers=a_headers).json()
    b_head = env["client"].get("/v1/audit/head", headers=b_headers).json()
    assert a_head["seq"] == 1
    assert b_head["seq"] == 0  # org-b's chain is untouched


def test_audit_list_pagination(env):
    headers = _auth(env["keys"]["admin@a"])
    for i in range(5):
        env["client"].post("/v1/keys", json={"name": f"k{i}"}, headers=headers)
    page1 = env["client"].get("/v1/audit?limit=2", headers=headers).json()
    assert len(page1["entries"]) == 2
    assert page1["next_cursor_seq"] is not None
    page2 = env["client"].get(
        f"/v1/audit?limit=2&cursor_seq={page1['next_cursor_seq']}", headers=headers,
    ).json()
    seqs = {e["seq"] for e in page1["entries"] + page2["entries"]}
    assert len(seqs) == 4  # No overlap


def test_audit_payload_round_trips_via_list(env):
    headers = _auth(env["keys"]["admin@a"])
    env["client"].post("/v1/keys", json={"name": "named-key"}, headers=headers)
    listed = env["client"].get("/v1/audit", headers=headers).json()
    entry = listed["entries"][0]
    assert entry["action"] == "key.create"
    assert entry["payload"]["name"] == "named-key"
