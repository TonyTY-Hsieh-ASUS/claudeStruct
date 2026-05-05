"""Tests for the cross-invocation silent-cache-miss detector."""
from __future__ import annotations

import time

import pytest

from claudestruct import cache_state


@pytest.fixture(autouse=True)
def isolated_state(tmp_path, monkeypatch):
    """Redirect state file to a tmp dir so tests don't touch ~/.claudestruct."""
    monkeypatch.setenv("CLAUDESTRUCT_HOME", str(tmp_path))
    yield


def test_no_warning_when_no_prior_state():
    p_hash = cache_state.prompt_hash("system prompt v1")
    warn = cache_state.check_for_silent_miss(
        task="dev", model="claude-opus-4-7",
        current_prompt_hash=p_hash, cache_read_tokens=0,
    )
    assert warn is None


def test_no_warning_on_cache_hit():
    p_hash = cache_state.prompt_hash("system prompt v1")
    cache_state.record_cache_write(
        task="dev", model="claude-opus-4-7",
        current_prompt_hash=p_hash,
        cache_creation_tokens=10000, cache_read_tokens=0,
    )
    warn = cache_state.check_for_silent_miss(
        task="dev", model="claude-opus-4-7",
        current_prompt_hash=p_hash, cache_read_tokens=5000,
    )
    assert warn is None


def test_warning_on_silent_miss_within_ttl():
    p_hash = cache_state.prompt_hash("system prompt v1")
    now = time.time()
    cache_state.record_cache_write(
        task="dev", model="claude-opus-4-7",
        current_prompt_hash=p_hash,
        cache_creation_tokens=10000, cache_read_tokens=0,
        now=now - 600,  # 10 min ago
    )
    warn = cache_state.check_for_silent_miss(
        task="dev", model="claude-opus-4-7",
        current_prompt_hash=p_hash, cache_read_tokens=0,
        now=now,
    )
    assert warn is not None
    assert "cache miss" in warn


def test_no_warning_when_prompt_hash_changed():
    """A prompt edit explains the cache miss — don't cry wolf."""
    now = time.time()
    cache_state.record_cache_write(
        task="dev", model="claude-opus-4-7",
        current_prompt_hash=cache_state.prompt_hash("v1"),
        cache_creation_tokens=10000, cache_read_tokens=0,
        now=now - 600,
    )
    warn = cache_state.check_for_silent_miss(
        task="dev", model="claude-opus-4-7",
        current_prompt_hash=cache_state.prompt_hash("v2"),
        cache_read_tokens=0, now=now,
    )
    assert warn is None


def test_no_warning_after_ttl():
    """Cache TTL expired — miss is expected."""
    now = time.time()
    p_hash = cache_state.prompt_hash("v1")
    cache_state.record_cache_write(
        task="dev", model="claude-opus-4-7",
        current_prompt_hash=p_hash,
        cache_creation_tokens=10000, cache_read_tokens=0,
        now=now - (cache_state.CACHE_TTL_SECONDS + 60),
    )
    warn = cache_state.check_for_silent_miss(
        task="dev", model="claude-opus-4-7",
        current_prompt_hash=p_hash, cache_read_tokens=0, now=now,
    )
    assert warn is None


def test_per_task_isolation():
    """A write for `dev` shouldn't trigger a warning for `review`."""
    now = time.time()
    cache_state.record_cache_write(
        task="dev", model="claude-opus-4-7",
        current_prompt_hash=cache_state.prompt_hash("dev-prompt"),
        cache_creation_tokens=10000, cache_read_tokens=0, now=now - 600,
    )
    warn = cache_state.check_for_silent_miss(
        task="review", model="claude-opus-4-7",
        current_prompt_hash=cache_state.prompt_hash("review-prompt"),
        cache_read_tokens=0, now=now,
    )
    assert warn is None


def test_corrupt_state_recovers_silently(tmp_path, monkeypatch):
    monkeypatch.setenv("CLAUDESTRUCT_HOME", str(tmp_path))
    (tmp_path / "cache_state.json").write_text("not json {{")
    warn = cache_state.check_for_silent_miss(
        task="dev", model="claude-opus-4-7",
        current_prompt_hash=cache_state.prompt_hash("v1"),
        cache_read_tokens=0,
    )
    assert warn is None
