"""Tests for env-var-driven timeout / max-retries fallbacks.

The Anthropic Python SDK accepts these via constructor — we never roll
our own retry loop, but we need to be sure that user-supplied env vars
make it through, and that a typo doesn't silently zero them out.
"""
from __future__ import annotations

from claudestruct import client


def test_env_float_default(monkeypatch):
    monkeypatch.delenv("CLAUDESTRUCT_TIMEOUT", raising=False)
    assert client._env_float("CLAUDESTRUCT_TIMEOUT", 300.0) == 300.0


def test_env_float_override(monkeypatch):
    monkeypatch.setenv("CLAUDESTRUCT_TIMEOUT", "120")
    assert client._env_float("CLAUDESTRUCT_TIMEOUT", 300.0) == 120.0


def test_env_float_invalid_falls_back(monkeypatch):
    monkeypatch.setenv("CLAUDESTRUCT_TIMEOUT", "soon")
    assert client._env_float("CLAUDESTRUCT_TIMEOUT", 300.0) == 300.0


def test_env_int_default(monkeypatch):
    monkeypatch.delenv("CLAUDESTRUCT_MAX_RETRIES", raising=False)
    assert client._env_int("CLAUDESTRUCT_MAX_RETRIES", 3) == 3


def test_env_int_override(monkeypatch):
    monkeypatch.setenv("CLAUDESTRUCT_MAX_RETRIES", "5")
    assert client._env_int("CLAUDESTRUCT_MAX_RETRIES", 3) == 5


def test_env_int_invalid_falls_back(monkeypatch):
    monkeypatch.setenv("CLAUDESTRUCT_MAX_RETRIES", "many")
    assert client._env_int("CLAUDESTRUCT_MAX_RETRIES", 3) == 3
