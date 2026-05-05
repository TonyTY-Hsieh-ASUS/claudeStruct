"""Tests for the PII / secret redactor and run-log retention (W5.3)."""
from __future__ import annotations

import os
import time
from datetime import timedelta

from claudestruct import redact

# --- Default ruleset ------------------------------------------------

def test_redacts_anthropic_key():
    r = redact.Redactor.default()
    s = "auth header: sk-ant-api03-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa next"
    out = r.redact_text(s)
    assert "sk-ant-" not in out
    assert "[redacted]" in out


def test_redacts_github_token():
    r = redact.Redactor.default()
    out = r.redact_text("token=ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa rest")
    assert "ghp_" not in out


def test_redacts_slack_token():
    r = redact.Redactor.default()
    out = r.redact_text("send xoxb-1234-abcd-ZZZZZZZZZZZZZZZZZZZZZZZZZZ to channel")
    assert "xoxb-" not in out


def test_redacts_stripe_key():
    r = redact.Redactor.default()
    out = r.redact_text("key=sk_live_abcdefghijklmnopqrstuv")
    assert "sk_live_" not in out


def test_redacts_aws_access_key():
    r = redact.Redactor.default()
    out = r.redact_text("AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE done")
    assert "AKIAIOSFODNN7EXAMPLE" not in out


def test_redacts_email():
    r = redact.Redactor.default()
    out = r.redact_text("contact alice@example.com please")
    assert "alice@example.com" not in out


def test_redacts_jwt():
    r = redact.Redactor.default()
    fake_jwt = (
        "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSIsIm5hbWUiOiJBbGljZSJ9."
        "abc123abc123abc123abc123"
    )
    out = r.redact_text(f"Bearer {fake_jwt} done")
    assert fake_jwt not in out


def test_does_not_touch_normal_text():
    r = redact.Redactor.default()
    out = r.redact_text("the quick brown fox jumps over the lazy dog")
    assert out == "the quick brown fox jumps over the lazy dog"


# --- Walking nested events ------------------------------------------

def test_walks_dict_values():
    r = redact.Redactor.default()
    event = {"type": "agent.usage", "model": "claude-opus-4-7",
             "note": "called with sk-ant-api03-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa key"}
    out = r.redact(event)
    assert "sk-ant-" not in out["note"]
    assert out["model"] == "claude-opus-4-7"


def test_walks_lists():
    r = redact.Redactor.default()
    event = {"warnings": ["call 1", "leaked sk-ant-aaaaaaaaaaaaaaaaaaaaaaaaaaaaa here"]}
    out = r.redact(event)
    assert "sk-ant-" not in out["warnings"][1]
    assert out["warnings"][0] == "call 1"


def test_passes_through_non_strings():
    r = redact.Redactor.default()
    event = {"cost_usd": 1.25, "calls": 3, "ok": True, "skip": None}
    assert r.redact(event) == event


def test_does_not_mutate_input():
    r = redact.Redactor.default()
    event = {"note": "alice@example.com"}
    r.redact(event)
    assert event == {"note": "alice@example.com"}


# --- Custom rules ---------------------------------------------------

def test_add_rule():
    r = redact.Redactor()
    r.add_rule("internal_id", r"INT-\d{6}")
    assert r.redact_text("ticket INT-123456 created") == "ticket [redacted] created"


def test_custom_placeholder():
    r = redact.Redactor.default()
    r.placeholder = "<scrubbed>"
    out = r.redact_text("alice@example.com")
    assert "<scrubbed>" in out


# --- Logging integration --------------------------------------------

def test_event_sink_writes_redacted_payload(tmp_path):
    from claudestruct import logging as event_log

    redactor = redact.Redactor.default()
    path = tmp_path / "run.jsonl"
    sink = event_log.EventSink(path=path, redactor=redactor)
    sink.open()
    sink.write({"type": "run.start", "task": "dev", "note": "alice@example.com"})
    sink.close()

    body = path.read_text(encoding="utf-8")
    assert "alice@example.com" not in body
    assert "[redacted]" in body


def test_event_sink_without_redactor_is_pass_through(tmp_path):
    from claudestruct import logging as event_log

    path = tmp_path / "run.jsonl"
    sink = event_log.EventSink(path=path)
    sink.open()
    sink.write({"type": "run.start", "task": "dev", "note": "alice@example.com"})
    sink.close()
    assert "alice@example.com" in path.read_text(encoding="utf-8")


# --- purge_runs -----------------------------------------------------

def test_purge_runs_no_dir(tmp_path):
    assert redact.purge_runs(tmp_path, older_than=timedelta(days=1)) == []


def test_purge_runs_skips_recent(tmp_path):
    runs_dir = tmp_path / ".claudestruct" / "runs"
    runs_dir.mkdir(parents=True)
    fresh = runs_dir / "fresh.jsonl"
    fresh.write_text("{}\n", encoding="utf-8")
    victims = redact.purge_runs(tmp_path, older_than=timedelta(days=30))
    assert victims == []
    assert fresh.exists()


def test_purge_runs_deletes_old(tmp_path):
    runs_dir = tmp_path / ".claudestruct" / "runs"
    runs_dir.mkdir(parents=True)
    old = runs_dir / "old.jsonl"
    old.write_text("{}\n", encoding="utf-8")
    # Backdate mtime by 60 days.
    sixty_days_ago = time.time() - 60 * 86400
    os.utime(old, (sixty_days_ago, sixty_days_ago))
    victims = redact.purge_runs(tmp_path, older_than=timedelta(days=30))
    assert victims == [old]
    assert not old.exists()


def test_purge_runs_dry_run_keeps_files(tmp_path):
    runs_dir = tmp_path / ".claudestruct" / "runs"
    runs_dir.mkdir(parents=True)
    old = runs_dir / "old.jsonl"
    old.write_text("{}\n", encoding="utf-8")
    sixty_days_ago = time.time() - 60 * 86400
    os.utime(old, (sixty_days_ago, sixty_days_ago))
    victims = redact.purge_runs(
        tmp_path, older_than=timedelta(days=30), dry_run=True,
    )
    assert victims == [old]
    assert old.exists()


def test_purge_runs_ignores_non_jsonl(tmp_path):
    runs_dir = tmp_path / ".claudestruct" / "runs"
    runs_dir.mkdir(parents=True)
    other = runs_dir / "README.txt"
    other.write_text("hi", encoding="utf-8")
    sixty_days_ago = time.time() - 60 * 86400
    os.utime(other, (sixty_days_ago, sixty_days_ago))
    assert redact.purge_runs(tmp_path, older_than=timedelta(days=30)) == []
    assert other.exists()
