"""Tests for the verdict-on-completion comment path (W6.6 follow-up).

Covers three slices:
  1. The new ``Run.github_*`` columns round-trip through the DB.
  2. ``format_verdict_body`` emits the expected Markdown for each terminal status.
  3. ``worker.process_pending_run`` posts a verdict comment on a webhook-triggered
     run and skips for runs without ``github_*`` fields populated.
  4. The webhook handler persists the PR coordinates onto the queued Run row.
"""
from __future__ import annotations

import hashlib
import hmac as _hmac
import json
from dataclasses import dataclass
from typing import Any

import pytest

pytest.importorskip("cryptography")
pytest.importorskip("fastapi")
pytest.importorskip("sqlalchemy")

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.pool import StaticPool

from claudestruct.server import github_app as gha
from claudestruct.server import worker as worker_mod
from claudestruct.server.app import create_app
from claudestruct.server.db import init_db, make_session_factory
from claudestruct.server.models import (
    GitHubInstallation,
    Membership,
    Org,
    Role,
    Run,
    RunStatus,
    User,
)

# --- format_verdict_body -------------------------------------------


def test_format_verdict_body_done_includes_cost_and_duration():
    body = gha.format_verdict_body(
        run_id="run-abc", status="done", cost_usd=0.0123, duration_ms=4500,
    )
    assert "completed" in body.lower()
    assert "run-abc" in body
    assert "$0.0123" in body
    assert "4.5s" in body


def test_format_verdict_body_failed_truncates_long_error():
    long_err = "A" * 5000
    body = gha.format_verdict_body(
        run_id="run-x", status="failed", error=long_err, duration_ms=1000,
    )
    assert "failed" in body.lower()
    assert "(truncated)" in body
    # Original 5KB error must not have all been pasted in.
    assert body.count("A") < 2000


def test_format_verdict_body_failed_handles_empty_error():
    body = gha.format_verdict_body(run_id="r", status="failed")
    assert "(no error message)" in body


def test_format_verdict_body_unknown_status_falls_back():
    """Unknown status should produce a neutral message rather than crash."""
    body = gha.format_verdict_body(run_id="r", status="weird-state")
    assert "weird-state" in body
    # Don't claim success or failure — just report the status.
    assert "completed" not in body.lower()
    assert "failed" not in body.lower()


def test_format_verdict_body_done_handles_missing_duration():
    body = gha.format_verdict_body(run_id="r", status="done", cost_usd=1.0)
    assert "unknown" in body  # duration_ms=None → "unknown"


# --- Run.github_* column round-trip --------------------------------


@pytest.fixture()
def factory():
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    init_db(engine)
    return make_session_factory(engine)


def test_run_github_columns_round_trip(factory):
    """Persist + reload a Run with the new fields populated."""
    with factory() as session:
        org = Org(slug="acme", name="Acme")
        user = User(email="bot@acme.test")
        session.add_all([org, user])
        session.flush()
        r = Run(
            run_id="run-1",
            org_id=org.id,
            user_id=user.id,
            status=RunStatus.queued.value,
            task="review",
            description="x",
            github_installation_id=12345,
            github_repo_full_name="acme/widgets",
            github_pr_number=42,
        )
        session.add(r)
        session.commit()
        session.refresh(r)
    with factory() as session:
        loaded = session.execute(select(Run).where(Run.run_id == "run-1")).scalar_one()
        assert loaded.github_installation_id == 12345
        assert loaded.github_repo_full_name == "acme/widgets"
        assert loaded.github_pr_number == 42


def test_run_github_columns_default_to_none_for_cli_runs(factory):
    """A run created without setting the github_* fields must not
    accidentally inherit values from another row."""
    with factory() as session:
        org = Org(slug="acme", name="Acme")
        user = User(email="cli@acme.test")
        session.add_all([org, user])
        session.flush()
        r = Run(
            run_id="run-cli",
            org_id=org.id, user_id=user.id,
            status=RunStatus.queued.value,
            task="dev", description="x",
        )
        session.add(r)
        session.commit()
        session.refresh(r)
    with factory() as session:
        loaded = session.execute(
            select(Run).where(Run.run_id == "run-cli")
        ).scalar_one()
        assert loaded.github_installation_id is None
        assert loaded.github_repo_full_name is None
        assert loaded.github_pr_number is None


# --- Webhook population --------------------------------------------


@pytest.fixture()
def webhook_env(tmp_path):
    """Mini-app fixture for the webhook → Run.github_* test path."""
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    init_db(engine)
    factory = make_session_factory(engine)
    with factory() as session:
        org = Org(slug="org-a", name="Org A")
        bot = User(email="github-bot@org-a.invalid", name="bot")
        session.add_all([org, bot])
        session.flush()
        session.add(Membership(
            user_id=bot.id, org_id=org.id, role=Role.member.value,
        ))
        session.add(GitHubInstallation(
            installation_id=12345,
            org_id=org.id,
            webhook_secret="hush",
            repo_filter=None,
            bot_user_id=bot.id,
        ))
        session.commit()
    app = create_app(engine=engine, run_root=str(tmp_path), skip_init=True)
    # Disable outbound calls — these tests focus on DB-side population.
    app.state.github_app_http_client = lambda: _FailHttp()
    client = TestClient(app)
    return {"app": app, "client": client, "factory": factory}


class _FailHttp:
    """Stand-in HTTP client that fails any outbound call. Used in tests
    that don't care about outbound POSTs and want to confirm a missing
    App config means we never reach the network."""

    def post(self, url, **kw):
        raise AssertionError(f"unexpected outbound POST to {url}")

    def close(self):
        pass


def _sign(secret: str, body: bytes) -> str:
    return "sha256=" + _hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()


def _pr_payload(*, installation_id=12345, action="opened",
                repo="acme/widgets", number=42):
    return {
        "action": action,
        "installation": {"id": installation_id},
        "repository": {"full_name": repo},
        "pull_request": {"number": number, "title": "t", "body": "b"},
    }


def test_webhook_persists_pr_coordinates_on_run(webhook_env, monkeypatch):
    """The webhook must save (installation_id, repo, pr_number) onto
    the Run row so the worker can post the verdict back later."""
    # Ensure no App config so the ack-comment path stays a no-op.
    monkeypatch.delenv("CLAUDESTRUCT_GITHUB_APP_ID", raising=False)
    monkeypatch.delenv("CLAUDESTRUCT_GITHUB_APP_PRIVATE_KEY_PEM", raising=False)
    payload = _pr_payload()
    body = json.dumps(payload).encode()
    sig = _sign("hush", body)
    r = webhook_env["client"].post(
        "/v1/github/webhook",
        content=body,
        headers={
            "X-GitHub-Event": "pull_request",
            "X-Hub-Signature-256": sig,
            "Content-Type": "application/json",
        },
    )
    assert r.status_code == 202
    run_id = r.json()["run_id"]

    with webhook_env["factory"]() as session:
        run = session.execute(select(Run).where(Run.run_id == run_id)).scalar_one()
        assert run.github_installation_id == 12345
        assert run.github_repo_full_name == "acme/widgets"
        assert run.github_pr_number == 42


# --- Worker post-completion verdict comment ------------------------


@dataclass
class _FakeOutcome:
    cost_usd: float = 0.05
    duration_ms: int = 1234
    result: Any = None


@dataclass
class _FakeUsage:
    input_tokens: int = 100
    output_tokens: int = 200
    cache_read_tokens: int = 50
    cache_creation_tokens: int = 0


def _ok_runner(**kw):
    """Stub runner that returns a deterministic outcome — keeps the
    worker test path off the real Anthropic SDK."""
    return _FakeOutcome(result=_FakeUsage())


def _failing_runner(**kw):
    from claudestruct.client import ClaudestructError
    raise ClaudestructError("API exploded")


class _RecordingHttp:
    """Captures POSTs so the test can assert that exactly the right
    sequence (token mint → comment post) happened."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, dict]] = []

    def post(self, url, **kw):
        self.calls.append((url, kw))
        if "access_tokens" in url:
            return _Resp(201, {
                "token": "ghs_t",
                "expires_at": "2099-01-01T00:00:00Z",
            })
        if "comments" in url:
            return _Resp(201, {"html_url": "https://github.com/x/y/issues/1#c-9"})
        return _Resp(404, {"message": "unmatched"})

    def close(self):
        pass


class _Resp:
    def __init__(self, status_code: int, payload: dict):
        self.status_code = status_code
        self._payload = payload

    def json(self):
        return self._payload


@pytest.fixture()
def rsa_pem():
    priv = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    return priv.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    )


def _make_worker_env(factory, *, with_pr_fields: bool = True):
    """Seed an org + user + a queued Run. Returns the run_id."""
    with factory() as session:
        org = Org(slug="acme", name="Acme")
        user = User(email="bot@acme.test")
        session.add_all([org, user])
        session.flush()
        r = Run(
            run_id="run-w-1",
            org_id=org.id, user_id=user.id,
            status=RunStatus.queued.value,
            task="review",
            description="please review",
            github_installation_id=99 if with_pr_fields else None,
            github_repo_full_name="acme/widgets" if with_pr_fields else None,
            github_pr_number=7 if with_pr_fields else None,
        )
        session.add(r)
        session.commit()
    return "run-w-1"


def test_worker_posts_verdict_on_done_when_app_configured(
    factory, rsa_pem, monkeypatch, tmp_path,
):
    """Successful run → ✅ verdict comment lands."""
    monkeypatch.setenv("CLAUDESTRUCT_GITHUB_APP_ID", "1")
    monkeypatch.setenv(
        "CLAUDESTRUCT_GITHUB_APP_PRIVATE_KEY_PEM", rsa_pem.decode("utf-8"),
    )
    http = _RecordingHttp()
    monkeypatch.setattr(worker_mod, "http_client_factory", lambda: http)
    monkeypatch.setattr(worker_mod, "_verdict_token_cache", None)

    _make_worker_env(factory)
    with factory() as session:
        worker_mod.process_pending_run(session, tmp_path, runner=_ok_runner)

    # Token mint then comment post.
    urls = [c[0] for c in http.calls]
    assert any("access_tokens" in u for u in urls)
    comment_calls = [c for c in http.calls if "comments" in c[0]]
    assert len(comment_calls) == 1
    body = comment_calls[0][1]["json"]["body"]
    assert "completed" in body.lower()
    assert "run-w-1" in body
    # PR number is in the URL path.
    assert "/issues/7/comments" in comment_calls[0][0]


def test_worker_posts_verdict_on_failed_runs(
    factory, rsa_pem, monkeypatch, tmp_path,
):
    """Failed run → ❌ verdict comment includes the error preview."""
    monkeypatch.setenv("CLAUDESTRUCT_GITHUB_APP_ID", "1")
    monkeypatch.setenv(
        "CLAUDESTRUCT_GITHUB_APP_PRIVATE_KEY_PEM", rsa_pem.decode("utf-8"),
    )
    http = _RecordingHttp()
    monkeypatch.setattr(worker_mod, "http_client_factory", lambda: http)
    monkeypatch.setattr(worker_mod, "_verdict_token_cache", None)

    _make_worker_env(factory)
    with factory() as session:
        worker_mod.process_pending_run(session, tmp_path, runner=_failing_runner)

    comment_calls = [c for c in http.calls if "comments" in c[0]]
    assert len(comment_calls) == 1
    body = comment_calls[0][1]["json"]["body"]
    assert "failed" in body.lower()
    assert "API exploded" in body


def test_worker_skips_verdict_when_run_has_no_github_fields(
    factory, rsa_pem, monkeypatch, tmp_path,
):
    """CLI / REST runs (no github_* fields) must NOT post a comment."""
    monkeypatch.setenv("CLAUDESTRUCT_GITHUB_APP_ID", "1")
    monkeypatch.setenv(
        "CLAUDESTRUCT_GITHUB_APP_PRIVATE_KEY_PEM", rsa_pem.decode("utf-8"),
    )
    http = _RecordingHttp()
    monkeypatch.setattr(worker_mod, "http_client_factory", lambda: http)
    monkeypatch.setattr(worker_mod, "_verdict_token_cache", None)

    _make_worker_env(factory, with_pr_fields=False)
    with factory() as session:
        worker_mod.process_pending_run(session, tmp_path, runner=_ok_runner)
    assert http.calls == []  # no outbound at all


def test_worker_skips_verdict_when_app_not_configured(
    factory, monkeypatch, tmp_path,
):
    """No CLAUDESTRUCT_GITHUB_APP_* env → silent skip, no crash."""
    monkeypatch.delenv("CLAUDESTRUCT_GITHUB_APP_ID", raising=False)
    monkeypatch.delenv("CLAUDESTRUCT_GITHUB_APP_PRIVATE_KEY_PEM", raising=False)
    # If the worker tried to post anyway, _FailHttp would AssertionError.
    monkeypatch.setattr(
        worker_mod, "http_client_factory", lambda: _FailHttp(),
    )

    _make_worker_env(factory)
    with factory() as session:
        run = worker_mod.process_pending_run(session, tmp_path, runner=_ok_runner)
    assert run is not None
    assert run.status == RunStatus.done.value


def test_worker_swallows_outbound_failures(
    factory, rsa_pem, monkeypatch, tmp_path,
):
    """A 5xx during the verdict post must NOT roll back the run's
    terminal state. Operators can re-trigger; losing run state would
    cost real money to redo."""
    monkeypatch.setenv("CLAUDESTRUCT_GITHUB_APP_ID", "1")
    monkeypatch.setenv(
        "CLAUDESTRUCT_GITHUB_APP_PRIVATE_KEY_PEM", rsa_pem.decode("utf-8"),
    )

    class _SadHttp:
        def __init__(self):
            self.calls = []

        def post(self, url, **kw):
            self.calls.append(url)
            if "access_tokens" in url:
                return _Resp(201, {
                    "token": "ghs_t", "expires_at": "2099-01-01T00:00:00Z",
                })
            return _Resp(503, {"message": "service down"})

        def close(self):
            pass

    sad = _SadHttp()
    monkeypatch.setattr(worker_mod, "http_client_factory", lambda: sad)
    monkeypatch.setattr(worker_mod, "_verdict_token_cache", None)

    _make_worker_env(factory)
    with factory() as session:
        run = worker_mod.process_pending_run(session, tmp_path, runner=_ok_runner)
    # Run still completed normally despite outbound failure.
    assert run is not None
    assert run.status == RunStatus.done.value
    # And the worker did try to post a comment (proving best-effort
    # actually attempted the call).
    assert any("comments" in u for u in sad.calls)
