"""Integration test: `client.run_task` short-circuits on cache hit (W10.4).

Drives the cache wiring end-to-end with a stub `Provider` so we don't
need a real Anthropic / Ollama endpoint. Confirms:

- First call → provider invoked, response written to cache, `cached=False`
- Second call (same inputs) → provider NOT invoked, response replayed
  from disk, `cached=True`, stream callback still fires once with the
  cached body
- `--no-llm-cache` (i.e. `llm_cache="off"`) bypasses the cache even
  when the env says ON
- Per-run `llm_cache="on"` enables caching even on the Anthropic
  provider (where auto policy is OFF by default)
"""
from __future__ import annotations

from typing import Any

import pytest

from claudestruct import client, local_cache, providers


class _StubProvider:
    """Records every `run_task` call so the test can assert miss vs hit."""

    def __init__(self, *, name: str = "openai", text: str = "hello world") -> None:
        self.name = name
        self.text = text
        self.calls: list[dict[str, Any]] = []

    def count_tokens(self, **_kwargs) -> int:
        return 42

    def run_task(self, **kwargs) -> dict[str, Any]:
        self.calls.append(kwargs)
        # Mirror real provider behavior: forward the body through the
        # caller's `stream_callback` so the cache-hit-vs-miss tests
        # can compare streaming behavior directly.
        cb = kwargs.get("stream_callback")
        if cb is not None and self.text:
            cb(self.text)
        return {
            "text": self.text,
            "input_tokens": 100,
            "output_tokens": 20,
            "cache_creation_tokens": 0,
            "cache_read_tokens": 0,
            "stop_reason": "end_turn",
            "model": kwargs.get("model"),
        }


@pytest.fixture()
def stub_openai_provider(monkeypatch, tmp_path):
    """Wire up a stub OpenAI-compat provider + isolated cache dir."""
    monkeypatch.setenv("CLAUDESTRUCT_PROVIDER", "openai")
    monkeypatch.setenv("CLAUDESTRUCT_HOME", str(tmp_path))
    monkeypatch.setenv("CLAUDESTRUCT_LLM_CACHE_DIR", str(tmp_path / "llm_cache"))
    monkeypatch.delenv("CLAUDESTRUCT_LLM_CACHE", raising=False)
    monkeypatch.setenv("CLAUDESTRUCT_MODEL_DEFAULT", "qwen2.5-coder:32b")
    stub = _StubProvider(name="openai")
    monkeypatch.setattr(providers, "make_provider", lambda *a, **kw: stub)
    return stub


def test_first_call_misses_then_caches(stub_openai_provider):
    streamed: list[str] = []
    result = client.run_task(
        "review", "look at this diff",
        max_tokens=1000, effort="high",
        stream_callback=streamed.append,
    )
    # Provider was hit; response was streamed live.
    assert len(stub_openai_provider.calls) == 1
    assert result.cached is False
    assert result.text == "hello world"
    assert streamed == ["hello world"]


def test_second_call_hits_cache_and_skips_provider(stub_openai_provider):
    # Prime the cache.
    client.run_task(
        "review", "look at this diff",
        max_tokens=1000, effort="high",
    )
    assert len(stub_openai_provider.calls) == 1

    # Second identical call: provider must NOT be invoked.
    streamed: list[str] = []
    result = client.run_task(
        "review", "look at this diff",
        max_tokens=1000, effort="high",
        stream_callback=streamed.append,
    )
    assert len(stub_openai_provider.calls) == 1, "provider should not have been called again"
    assert result.cached is True
    assert result.stop_reason == "cached"
    assert result.text == "hello world"
    # Cached body still fires through the stream_callback once so the
    # CLI render path doesn't have to special-case "no streaming".
    assert streamed == ["hello world"]


def test_different_effort_misses_cache(stub_openai_provider):
    """`effort` is part of the cache key; a `--effort low` replay must
    not silently serve a `--effort max` response."""
    client.run_task("review", "x", max_tokens=1000, effort="high")
    client.run_task("review", "x", max_tokens=1000, effort="low")
    assert len(stub_openai_provider.calls) == 2


def test_different_max_tokens_misses_cache(stub_openai_provider):
    client.run_task("review", "x", max_tokens=1000, effort="high")
    client.run_task("review", "x", max_tokens=2000, effort="high")
    assert len(stub_openai_provider.calls) == 2


def test_no_cache_flag_forces_fresh_call(stub_openai_provider):
    """Per-run `llm_cache="off"` bypasses cache even when the env path
    would normally serve from disk."""
    client.run_task("review", "x", max_tokens=1000, effort="high")
    client.run_task(
        "review", "x", max_tokens=1000, effort="high", llm_cache="off",
    )
    assert len(stub_openai_provider.calls) == 2


def test_anthropic_default_does_not_cache(monkeypatch, tmp_path):
    """Auto policy: Anthropic provider doesn't write to local cache by
    default (the SDK + server-side ephemeral cache already handle it)."""
    monkeypatch.setenv("CLAUDESTRUCT_PROVIDER", "anthropic")
    monkeypatch.setenv("CLAUDESTRUCT_HOME", str(tmp_path))
    monkeypatch.setenv("CLAUDESTRUCT_LLM_CACHE_DIR", str(tmp_path / "llm_cache"))
    monkeypatch.delenv("CLAUDESTRUCT_LLM_CACHE", raising=False)
    stub = _StubProvider(name="anthropic")
    monkeypatch.setattr(providers, "make_provider", lambda *a, **kw: stub)
    monkeypatch.setattr(providers, "default_model_for", lambda _name: "claude-opus-4-7")

    client.run_task("review", "x", max_tokens=1000)
    client.run_task("review", "x", max_tokens=1000)
    # Both calls hit the (stubbed) provider — no cache short-circuit.
    assert len(stub.calls) == 2


def test_per_run_on_overrides_auto_anthropic(monkeypatch, tmp_path):
    """User who explicitly opts in to `--llm-cache` wins over the
    Anthropic-default-off policy."""
    monkeypatch.setenv("CLAUDESTRUCT_PROVIDER", "anthropic")
    monkeypatch.setenv("CLAUDESTRUCT_HOME", str(tmp_path))
    monkeypatch.setenv("CLAUDESTRUCT_LLM_CACHE_DIR", str(tmp_path / "llm_cache"))
    monkeypatch.delenv("CLAUDESTRUCT_LLM_CACHE", raising=False)
    stub = _StubProvider(name="anthropic")
    monkeypatch.setattr(providers, "make_provider", lambda *a, **kw: stub)
    monkeypatch.setattr(providers, "default_model_for", lambda _name: "claude-opus-4-7")

    client.run_task("review", "x", max_tokens=1000, llm_cache="on")
    client.run_task("review", "x", max_tokens=1000, llm_cache="on")
    assert len(stub.calls) == 1


def test_cache_write_io_failure_does_not_abort_run(monkeypatch, stub_openai_provider, capsys):
    """A full disk / permissions issue on the cache write path must
    NOT take down the user's run — we log and continue."""
    def boom(*_a, **_kw):
        raise OSError("disk full")
    monkeypatch.setattr(local_cache, "put", boom)

    result = client.run_task("review", "x", max_tokens=1000)
    # Provider call succeeded; the cache write failure was swallowed.
    assert result.text == "hello world"
    captured = capsys.readouterr()
    assert "[llm_cache] write failed" in captured.err
