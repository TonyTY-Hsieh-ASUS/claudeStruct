"""Sentry init + redaction tests.

The wire to sentry-sdk is opt-in via env, so most users never touch
this code path. But when it IS active, it ships error events to a
remote service — we MUST redact before send. These tests pin every
field path the scrubber covers and the disabled-by-default behaviour.
"""
from __future__ import annotations

import pytest

from claudestruct import sentry_init


@pytest.fixture(autouse=True)
def _reset(monkeypatch):
    monkeypatch.setattr(sentry_init, "_initialized", False)
    monkeypatch.setattr(sentry_init, "_enabled", False)
    yield


def test_disabled_when_no_dsn(monkeypatch):
    monkeypatch.delenv("CLAUDESTRUCT_SENTRY_DSN", raising=False)
    assert sentry_init.init() is False
    assert sentry_init.is_enabled() is False


def test_capture_exception_is_safe_when_disabled(monkeypatch):
    monkeypatch.delenv("CLAUDESTRUCT_SENTRY_DSN", raising=False)
    sentry_init.init()
    # Must not raise even when SDK is uninitialized.
    sentry_init.capture_exception(RuntimeError("safe"))


def test_init_is_idempotent(monkeypatch):
    monkeypatch.delenv("CLAUDESTRUCT_SENTRY_DSN", raising=False)
    assert sentry_init.init() is False
    assert sentry_init.init() is False


def test_redact_removes_top_level_api_keys():
    event = {
        "extra": {
            "ANTHROPIC_API_KEY": "sk-ant-secret",
            "regular_field": "ok",
        },
        "tags": {"GITHUB_TOKEN": "ghp_xxx", "version": "1.0"},
    }
    out = sentry_init._scrub_event(event, {})
    assert out["extra"]["ANTHROPIC_API_KEY"] == "[redacted]"
    assert out["extra"]["regular_field"] == "ok"
    assert out["tags"]["GITHUB_TOKEN"] == "[redacted]"
    assert out["tags"]["version"] == "1.0"


def test_redact_handles_nested_dicts():
    event = {
        "contexts": {
            "config": {
                "api_key": "secret",
                "model": "claude-opus-4-7",
                "nested": {"slack_bot_token": "xoxb-xxx"},
            },
        },
    }
    out = sentry_init._scrub_event(event, {})
    assert out["contexts"]["config"]["api_key"] == "[redacted]"
    assert out["contexts"]["config"]["model"] == "claude-opus-4-7"
    assert out["contexts"]["config"]["nested"]["slack_bot_token"] == "[redacted]"


def test_redact_request_env_and_headers():
    event = {
        "request": {
            "env": {"OPENAI_API_KEY": "sk-xxx"},
            "headers": {
                "Authorization": "Bearer secret",
                "Content-Type": "application/json",
                "X-API-Key": "another-secret",
            },
        },
    }
    out = sentry_init._scrub_event(event, {})
    assert out["request"]["env"]["OPENAI_API_KEY"] == "[redacted]"
    assert out["request"]["headers"]["Authorization"] == "[redacted]"
    assert out["request"]["headers"]["Content-Type"] == "application/json"
    assert out["request"]["headers"]["X-API-Key"] == "[redacted]"


def test_redact_headers_in_list_form():
    """Some integrations serialise headers as list of [name, value]."""
    event = {
        "request": {
            "headers": [
                ["Authorization", "Bearer secret"],
                ["Content-Type", "application/json"],
            ],
        },
    }
    out = sentry_init._scrub_event(event, {})
    headers = out["request"]["headers"]
    assert headers[0] == ["Authorization", "[redacted]"]
    assert headers[1] == ["Content-Type", "application/json"]


def test_redact_breadcrumb_data_and_message():
    event = {
        "breadcrumbs": {
            "values": [
                {"data": {"slack_app_token": "xapp-xxx"}, "message": "ok"},
                {"data": {}, "message": "Caller passed ANTHROPIC_API_KEY=sk-xxx"},
            ],
        },
    }
    out = sentry_init._scrub_event(event, {})
    bc = out["breadcrumbs"]["values"]
    assert bc[0]["data"]["slack_app_token"] == "[redacted]"
    # The free-form message gets the trailing token elided.
    assert "[redacted]" in bc[1]["message"]
    # Whatever's left after redaction shouldn't carry the literal token.
    assert "sk-xxx" not in bc[1]["message"]


def test_redact_pattern_covers_known_keys():
    """Lock the redaction substring set so we don't accidentally narrow
    the matcher in a future refactor and silently start leaking."""
    must_match = [
        "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_API_KEY",
        "MINIMAX_API_KEY", "SLACK_BOT_TOKEN", "SLACK_APP_TOKEN",
        "GITHUB_TOKEN", "CLAW_WEB_TOKEN", "auth_token", "secret_value",
        "API-Key", "bearer-prefix", "password",
    ]
    for k in must_match:
        assert sentry_init._REDACT_PATTERNS.search(k), f"{k!r} should be matched"

    must_not_match = ["model", "user_id", "request_id", "version"]
    for k in must_not_match:
        assert not sentry_init._REDACT_PATTERNS.search(k), f"{k!r} should NOT match"


def test_init_with_explicit_dsn(monkeypatch):
    """init(dsn='…') trumps env-var lookup."""
    monkeypatch.delenv("CLAUDESTRUCT_SENTRY_DSN", raising=False)
    pytest.importorskip("sentry_sdk")
    import sentry_sdk

    captured = {}

    def fake_init(**kwargs):
        captured.update(kwargs)

    monkeypatch.setattr(sentry_sdk, "init", fake_init)
    assert sentry_init.init(dsn="https://example@sentry.io/1") is True
    assert captured["dsn"] == "https://example@sentry.io/1"
    # before_send hook is wired so production scrubbing is in effect.
    assert captured["before_send"] is sentry_init._scrub_event
    assert captured["traces_sample_rate"] == 0.0
    assert captured["send_default_pii"] is False
