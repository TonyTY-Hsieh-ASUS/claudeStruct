"""Tests for the GitHub Checks API path (W6.6 follow-up).

Covers four slices:
  1. ``format_check_run_payload`` shape + validation (status / conclusion).
  2. ``post_check_run`` + ``patch_check_run`` HTTP behaviour (mocked).
  3. ``format_completed_check_payload`` outcome → conclusion mapping.
  4. Worker integration: in_progress on claim + PATCH on completion;
     fresh POST when the in_progress open failed; full skip when the
     run wasn't webhook-triggered.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

import pytest

pytest.importorskip("cryptography")
pytest.importorskip("fastapi")
pytest.importorskip("sqlalchemy")

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from sqlalchemy import create_engine, select
from sqlalchemy.pool import StaticPool

from claudestruct.server import github_app as gha
from claudestruct.server import worker as worker_mod
from claudestruct.server.db import init_db, make_session_factory
from claudestruct.server.models import Org, Run, RunStatus, User

# --- format_check_run_payload --------------------------------------


def test_format_check_run_payload_minimal_shape():
    p = gha.format_check_run_payload(
        name="claudeStruct", head_sha="abc123", status="queued",
    )
    assert p["name"] == "claudeStruct"
    assert p["head_sha"] == "abc123"
    assert p["status"] == "queued"
    assert "conclusion" not in p
    assert "output" not in p


def test_format_check_run_payload_in_progress_with_output():
    p = gha.format_check_run_payload(
        name="claudeStruct", head_sha="abc", status="in_progress",
        title="working on it", summary="run-1 started",
        external_id="run-1",
    )
    assert p["status"] == "in_progress"
    assert p["output"]["title"] == "working on it"
    assert p["output"]["summary"] == "run-1 started"
    assert p["external_id"] == "run-1"


def test_format_check_run_payload_completed_requires_conclusion():
    with pytest.raises(gha.GitHubAppError, match="requires a conclusion"):
        gha.format_check_run_payload(
            name="claudeStruct", head_sha="abc", status="completed",
        )


def test_format_check_run_payload_invalid_conclusion_rejected():
    with pytest.raises(gha.GitHubAppError, match="unknown.*conclusion"):
        gha.format_check_run_payload(
            name="claudeStruct", head_sha="abc",
            status="completed", conclusion="awesome",
        )


def test_format_check_run_payload_conclusion_without_completed_rejected():
    """conclusion is only valid when status='completed' (GitHub 422s)."""
    with pytest.raises(gha.GitHubAppError, match="only valid"):
        gha.format_check_run_payload(
            name="x", head_sha="abc",
            status="in_progress", conclusion="success",
        )


def test_format_check_run_payload_invalid_status_rejected():
    with pytest.raises(gha.GitHubAppError, match="status must be"):
        gha.format_check_run_payload(
            name="x", head_sha="abc", status="weird",
        )


def test_format_check_run_payload_output_title_defaults_to_name():
    """Output without an explicit title uses the run name (GitHub
    requires output.title when output is present)."""
    p = gha.format_check_run_payload(
        name="claudeStruct", head_sha="abc",
        status="completed", conclusion="success",
        summary="ok",  # title omitted
    )
    assert p["output"]["title"] == "claudeStruct"
    assert p["output"]["summary"] == "ok"


# --- format_completed_check_payload --------------------------------


def test_format_completed_check_payload_done_maps_to_success():
    p = gha.format_completed_check_payload(
        head_sha="abc", run_id="run-1", status="done",
        cost_usd=0.0123, duration_ms=1500,
    )
    assert p["status"] == "completed"
    assert p["conclusion"] == "success"
    assert "$0.0123" in p["output"]["summary"]
    assert "1.5s" in p["output"]["summary"]
    assert p["external_id"] == "run-1"


def test_format_completed_check_payload_failed_maps_to_failure():
    p = gha.format_completed_check_payload(
        head_sha="abc", run_id="run-1", status="failed",
        error="boom kapow", duration_ms=200,
    )
    assert p["conclusion"] == "failure"
    assert "boom kapow" in p["output"]["summary"]


def test_format_completed_check_payload_failed_truncates_error():
    p = gha.format_completed_check_payload(
        head_sha="abc", run_id="run-1", status="failed",
        error="X" * 5000,
    )
    assert "(truncated)" in p["output"]["summary"]
    # Limit defends against blowing GitHub's 65k summary cap
    assert p["output"]["summary"].count("X") < 2000


def test_format_completed_check_payload_unknown_status_neutral():
    """An unexpected enum value should still produce a valid Checks
    API call rather than crash the worker."""
    p = gha.format_completed_check_payload(
        head_sha="abc", run_id="run-1", status="some-future-state",
    )
    assert p["conclusion"] == "neutral"
    assert "some-future-state" in p["output"]["summary"]


# --- post_check_run / patch_check_run HTTP -------------------------


class _Resp:
    def __init__(self, status_code: int, payload: dict):
        self.status_code = status_code
        self._payload = payload

    def json(self):
        return self._payload


class _Stub:
    """Records POSTs + PATCHes; returns a per-test scripted response."""

    def __init__(self, post: _Resp | None = None, patch: _Resp | None = None):
        self._post = post
        self._patch = patch
        self.calls: list[tuple[str, str, dict]] = []

    def post(self, url, **kw):
        self.calls.append(("POST", url, kw))
        return self._post or _Resp(500, {"error": "no plan"})

    def patch(self, url, **kw):
        self.calls.append(("PATCH", url, kw))
        return self._patch or _Resp(500, {"error": "no plan"})

    def close(self):
        pass


def test_post_check_run_returns_response_body_and_id():
    client = _Stub(post=_Resp(201, {
        "id": 4242, "html_url": "https://github.com/o/r/runs/4242",
    }))
    body = gha.post_check_run(
        repo_full_name="o/r",
        payload={"name": "x", "head_sha": "abc", "status": "queued"},
        install_token="ghs_t", http_client=client,
    )
    assert body["id"] == 4242
    method, url, kw = client.calls[0]
    assert method == "POST"
    assert url.endswith("/repos/o/r/check-runs")
    assert kw["headers"]["Authorization"] == "Bearer ghs_t"


def test_post_check_run_rejects_bad_repo_format():
    client = _Stub(post=_Resp(201, {"id": 1}))
    with pytest.raises(gha.GitHubAppError, match="owner/name"):
        gha.post_check_run(
            repo_full_name="just-a-name", payload={}, install_token="t",
            http_client=client,
        )


def test_post_check_run_raises_on_non_201():
    client = _Stub(post=_Resp(403, {"message": "forbidden"}))
    with pytest.raises(gha.GitHubAppError, match="status=403"):
        gha.post_check_run(
            repo_full_name="o/r", payload={}, install_token="t",
            http_client=client,
        )


def test_post_check_run_raises_on_missing_id():
    client = _Stub(post=_Resp(201, {"html_url": "x"}))  # no id
    with pytest.raises(gha.GitHubAppError, match="numeric id"):
        gha.post_check_run(
            repo_full_name="o/r", payload={}, install_token="t",
            http_client=client,
        )


def test_patch_check_run_targets_id_in_url():
    client = _Stub(patch=_Resp(200, {"id": 4242, "status": "completed"}))
    body = gha.patch_check_run(
        repo_full_name="o/r", check_run_id=4242,
        payload={"status": "completed", "conclusion": "success"},
        install_token="t", http_client=client,
    )
    assert body["id"] == 4242
    method, url, _ = client.calls[0]
    assert method == "PATCH"
    assert url.endswith("/repos/o/r/check-runs/4242")


def test_patch_check_run_raises_on_non_200():
    client = _Stub(patch=_Resp(404, {"message": "missing"}))
    with pytest.raises(gha.GitHubAppError, match="status=404"):
        gha.patch_check_run(
            repo_full_name="o/r", check_run_id=4242,
            payload={"status": "completed", "conclusion": "success"},
            install_token="t", http_client=client,
        )


# --- Worker integration --------------------------------------------


@pytest.fixture()
def factory():
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    init_db(engine)
    return make_session_factory(engine)


@pytest.fixture()
def rsa_pem():
    priv = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    return priv.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    )


@dataclass
class _FakeUsage:
    input_tokens: int = 100
    output_tokens: int = 200
    cache_read_tokens: int = 50
    cache_creation_tokens: int = 0


@dataclass
class _FakeOutcome:
    cost_usd: float = 0.05
    duration_ms: int = 1234
    result: Any = None


def _ok_runner(**kw):
    return _FakeOutcome(result=_FakeUsage())


def _failing_runner(**kw):
    from claudestruct.client import ClaudestructError
    raise ClaudestructError("API exploded")


class _CheckRunHttp:
    """Captures POSTs + PATCHes across token-mint, comment-post, and
    check-run paths so worker integration tests can assert the full
    sequence."""

    def __init__(self, *, fail_open: bool = False) -> None:
        self.calls: list[tuple[str, str]] = []
        self._fail_open = fail_open

    def post(self, url, **kw):
        self.calls.append(("POST", url))
        if "access_tokens" in url:
            return _Resp(201, {
                "token": "ghs_t", "expires_at": "2099-01-01T00:00:00Z",
            })
        if "comments" in url:
            return _Resp(201, {"html_url": "https://github.com/x/y/issues/1#c-1"})
        if "check-runs" in url:
            if self._fail_open:
                return _Resp(503, {"message": "service down"})
            return _Resp(201, {"id": 4242, "html_url": "https://x/runs/4242"})
        return _Resp(404, {"message": "unmatched"})

    def patch(self, url, **kw):
        self.calls.append(("PATCH", url))
        if "check-runs" in url:
            return _Resp(200, {"id": 4242, "status": "completed"})
        return _Resp(404, {"message": "unmatched"})

    def close(self):
        pass


def _seed_webhook_run(factory, *, head_sha: str | None = "abc123") -> str:
    """Seed a queued, webhook-triggered Run row. Returns the run_id."""
    with factory() as session:
        org = Org(slug="acme", name="Acme")
        user = User(email="bot@acme.test")
        session.add_all([org, user])
        session.flush()
        session.add(Run(
            run_id="run-w-1",
            org_id=org.id, user_id=user.id,
            status=RunStatus.queued.value,
            task="review", description="please review",
            github_installation_id=99,
            github_repo_full_name="o/r",
            github_pr_number=7,
            github_head_sha=head_sha,
        ))
        session.commit()
    return "run-w-1"


def test_worker_opens_in_progress_check_run_on_claim(
    factory, rsa_pem, monkeypatch, tmp_path,
):
    monkeypatch.setenv("CLAUDESTRUCT_GITHUB_APP_ID", "1")
    monkeypatch.setenv(
        "CLAUDESTRUCT_GITHUB_APP_PRIVATE_KEY_PEM", rsa_pem.decode("utf-8"),
    )
    http = _CheckRunHttp()
    monkeypatch.setattr(worker_mod, "http_client_factory", lambda: http)
    monkeypatch.setattr(worker_mod, "_verdict_token_cache", None)

    _seed_webhook_run(factory)
    with factory() as session:
        worker_mod.process_pending_run(session, tmp_path, runner=_ok_runner)

    # We should see: token mint(s) → in_progress POST → comment POST →
    # patch on completion → completed PATCH on check-run.
    methods_urls = http.calls
    assert any(
        m == "POST" and "check-runs" in u
        for m, u in methods_urls
    ), "in_progress check-run was not opened"
    assert any(
        m == "PATCH" and "check-runs/4242" in u
        for m, u in methods_urls
    ), "completed PATCH was not sent"

    # Run row records the check-run id so subsequent updates target it.
    with factory() as session:
        loaded = session.execute(
            select(Run).where(Run.run_id == "run-w-1")
        ).scalar_one()
        assert loaded.github_check_run_id == 4242


def test_worker_skips_check_run_when_no_head_sha(
    factory, rsa_pem, monkeypatch, tmp_path,
):
    """issue_comment-triggered runs leave head_sha=None and must NOT
    hit the Checks API path. Comment-based verdict still fires."""
    monkeypatch.setenv("CLAUDESTRUCT_GITHUB_APP_ID", "1")
    monkeypatch.setenv(
        "CLAUDESTRUCT_GITHUB_APP_PRIVATE_KEY_PEM", rsa_pem.decode("utf-8"),
    )
    http = _CheckRunHttp()
    monkeypatch.setattr(worker_mod, "http_client_factory", lambda: http)
    monkeypatch.setattr(worker_mod, "_verdict_token_cache", None)

    _seed_webhook_run(factory, head_sha=None)
    with factory() as session:
        worker_mod.process_pending_run(session, tmp_path, runner=_ok_runner)

    assert not any("check-runs" in u for _, u in http.calls)
    # Comment path still runs (head_sha is unrelated to comment posting).
    assert any("comments" in u for _, u in http.calls)


def test_worker_falls_back_to_post_when_in_progress_open_failed(
    factory, rsa_pem, monkeypatch, tmp_path,
):
    """If the in_progress POST fails (network or auth), the worker
    must still POST a fresh completed check-run on terminal so the
    PR shows the verdict — instead of leaving a stale 'in progress'."""
    monkeypatch.setenv("CLAUDESTRUCT_GITHUB_APP_ID", "1")
    monkeypatch.setenv(
        "CLAUDESTRUCT_GITHUB_APP_PRIVATE_KEY_PEM", rsa_pem.decode("utf-8"),
    )
    http = _CheckRunHttp(fail_open=True)
    monkeypatch.setattr(worker_mod, "http_client_factory", lambda: http)
    monkeypatch.setattr(worker_mod, "_verdict_token_cache", None)

    _seed_webhook_run(factory)
    with factory() as session:
        worker_mod.process_pending_run(session, tmp_path, runner=_ok_runner)

    # No PATCH (no id was persisted because POST 503'd); a fresh POST
    # to /check-runs (without an id) must have happened on completion.
    posts_to_check_runs = [
        u for m, u in http.calls
        if m == "POST" and u.endswith("/check-runs")
    ]
    # The first POST is the failed in_progress, the second is the
    # fallback completed POST. Total: 2.
    assert len(posts_to_check_runs) >= 2
    patches_to_check_runs = [
        u for m, u in http.calls
        if m == "PATCH" and "check-runs" in u
    ]
    assert patches_to_check_runs == []  # no id to PATCH


def test_worker_skips_when_app_not_configured(
    factory, monkeypatch, tmp_path,
):
    """No CLAUDESTRUCT_GITHUB_APP_* env: silent skip across both
    comment AND checks paths. This is the OSS / unconfigured shape."""
    monkeypatch.delenv("CLAUDESTRUCT_GITHUB_APP_ID", raising=False)
    monkeypatch.delenv("CLAUDESTRUCT_GITHUB_APP_PRIVATE_KEY_PEM", raising=False)

    class _FailHttp:
        def post(self, url, **kw):
            raise AssertionError(f"unexpected outbound POST to {url}")

        def patch(self, url, **kw):
            raise AssertionError(f"unexpected outbound PATCH to {url}")

        def close(self):
            pass

    monkeypatch.setattr(
        worker_mod, "http_client_factory", lambda: _FailHttp(),
    )
    _seed_webhook_run(factory)
    with factory() as session:
        run = worker_mod.process_pending_run(session, tmp_path, runner=_ok_runner)
    assert run is not None
    assert run.status == RunStatus.done.value


def test_worker_check_run_failure_does_not_roll_back_run_state(
    factory, rsa_pem, monkeypatch, tmp_path,
):
    """A 5xx during ANY check-run call must not roll back the run's
    terminal status. Operators can re-trigger; losing run state would
    cost real money to redo."""
    monkeypatch.setenv("CLAUDESTRUCT_GITHUB_APP_ID", "1")
    monkeypatch.setenv(
        "CLAUDESTRUCT_GITHUB_APP_PRIVATE_KEY_PEM", rsa_pem.decode("utf-8"),
    )

    class _AllFailHttp:
        def __init__(self):
            self.calls = []

        def post(self, url, **kw):
            self.calls.append(url)
            if "access_tokens" in url:
                return _Resp(201, {
                    "token": "ghs_t", "expires_at": "2099-01-01T00:00:00Z",
                })
            return _Resp(503, {"message": "down"})

        def patch(self, url, **kw):
            self.calls.append(url)
            return _Resp(503, {"message": "down"})

        def close(self):
            pass

    sad = _AllFailHttp()
    monkeypatch.setattr(worker_mod, "http_client_factory", lambda: sad)
    monkeypatch.setattr(worker_mod, "_verdict_token_cache", None)

    _seed_webhook_run(factory)
    with factory() as session:
        run = worker_mod.process_pending_run(session, tmp_path, runner=_ok_runner)
    assert run is not None
    assert run.status == RunStatus.done.value


def test_worker_completed_check_run_for_failed_run(
    factory, rsa_pem, monkeypatch, tmp_path,
):
    """A failed run must produce a `conclusion=failure` check-run."""
    monkeypatch.setenv("CLAUDESTRUCT_GITHUB_APP_ID", "1")
    monkeypatch.setenv(
        "CLAUDESTRUCT_GITHUB_APP_PRIVATE_KEY_PEM", rsa_pem.decode("utf-8"),
    )

    captured_payloads: list[dict] = []

    class _CapHttp(_CheckRunHttp):
        def patch(self, url, **kw):
            self.calls.append(("PATCH", url))
            if "check-runs" in url:
                captured_payloads.append(kw.get("json") or {})
                return _Resp(200, {"id": 4242, "status": "completed"})
            return _Resp(404, {"message": "unmatched"})

    http = _CapHttp()
    monkeypatch.setattr(worker_mod, "http_client_factory", lambda: http)
    monkeypatch.setattr(worker_mod, "_verdict_token_cache", None)

    _seed_webhook_run(factory)
    with factory() as session:
        worker_mod.process_pending_run(session, tmp_path, runner=_failing_runner)

    assert captured_payloads
    payload = captured_payloads[0]
    assert payload["status"] == "completed"
    assert payload["conclusion"] == "failure"


# --- Webhook persists head_sha ------------------------------------


def test_webhook_persists_head_sha_on_run():
    """detect_trigger pulls pull_request.head.sha out of the payload
    and the webhook router persists it onto the Run row."""
    from claudestruct.server.routers.github import detect_trigger
    payload = {
        "action": "opened",
        "installation": {"id": 1},
        "repository": {"full_name": "o/r"},
        "pull_request": {
            "number": 1, "title": "t", "body": "b",
            "head": {"sha": "deadbeef"},
        },
    }
    decision = detect_trigger("pull_request", payload)
    assert decision is not None
    assert decision["head_sha"] == "deadbeef"


def test_detect_trigger_issue_comment_returns_no_head_sha():
    """issue_comment payloads don't carry head_sha; head_sha must be
    None so the worker skips the Checks-API path."""
    from claudestruct.server.routers.github import detect_trigger
    payload = {
        "action": "created",
        "installation": {"id": 1},
        "repository": {"full_name": "o/r"},
        "issue": {"number": 1, "pull_request": {"url": "..."}},
        "comment": {"body": "/cs review", "user": {"login": "alice"}},
    }
    decision = detect_trigger("issue_comment", payload)
    assert decision is not None
    assert decision["head_sha"] is None


def test_detect_trigger_pr_without_head_sha_returns_none_for_field():
    """A malformed PR payload (no head.sha) must not crash; head_sha
    falls back to None and the worker skips the Checks-API path."""
    from claudestruct.server.routers.github import detect_trigger
    payload = {
        "action": "opened",
        "installation": {"id": 1},
        "repository": {"full_name": "o/r"},
        "pull_request": {"number": 1, "title": "t", "body": "b"},
        # no `head` field at all
    }
    decision = detect_trigger("pull_request", payload)
    assert decision is not None
    assert decision["head_sha"] is None


# --- Run.github_head_sha + check_run_id round-trip -----------------


def test_run_head_sha_and_check_run_id_round_trip(factory):
    with factory() as session:
        org = Org(slug="acme", name="Acme")
        user = User(email="bot@acme.test")
        session.add_all([org, user])
        session.flush()
        r = Run(
            run_id="run-1",
            org_id=org.id, user_id=user.id,
            status=RunStatus.queued.value,
            task="review", description="x",
            github_head_sha="cafef00d",
            github_check_run_id=4242,
        )
        session.add(r)
        session.commit()
    with factory() as session:
        loaded = session.execute(select(Run).where(Run.run_id == "run-1")).scalar_one()
        assert loaded.github_head_sha == "cafef00d"
        assert loaded.github_check_run_id == 4242


# pin so unused-imports check doesn't fire
_ = datetime(2026, 4, 28, tzinfo=timezone.utc)
