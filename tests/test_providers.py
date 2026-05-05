"""Provider abstraction tests (W10.1).

We don't actually exercise the OpenAI / Anthropic SDKs — that's
integration-test territory. The cases here lock in:

- Selection logic: env var → provider name → constructed class.
- The OpenAI provider's pure helpers (message shape, tokenization
  fallback path, streaming aggregator).
- The Anthropic provider's `_system_blocks` continues to emit the
  `cache_control` breakpoint that makes prompt caching land.
- Defensive fallbacks: unknown `CLAUDESTRUCT_PROVIDER` → anthropic.
"""
from __future__ import annotations

from unittest.mock import MagicMock

import pytest

from claudestruct import providers

# --- Selection ------------------------------------------------------


def test_active_provider_defaults_to_anthropic(monkeypatch):
    monkeypatch.delenv("CLAUDESTRUCT_PROVIDER", raising=False)
    assert providers.active_provider_name() == "anthropic"


def test_active_provider_reads_env(monkeypatch):
    monkeypatch.setenv("CLAUDESTRUCT_PROVIDER", "openai")
    assert providers.active_provider_name() == "openai"


def test_active_provider_unknown_value_falls_back(monkeypatch):
    """Typos in CLAUDESTRUCT_PROVIDER mustn't blow up unrelated commands."""
    monkeypatch.setenv("CLAUDESTRUCT_PROVIDER", "ollama-direct")
    assert providers.active_provider_name() == "anthropic"


def test_default_model_per_provider(monkeypatch):
    monkeypatch.delenv("CLAUDESTRUCT_MODEL_DEFAULT", raising=False)
    assert providers.default_model_for("anthropic") == providers.DEFAULT_ANTHROPIC_MODEL
    assert providers.default_model_for("openai") == providers.DEFAULT_OPENAI_MODEL


def test_default_model_env_override(monkeypatch):
    """A GX10 user puts `qwen2.5-coder:32b` in their shell profile."""
    monkeypatch.setenv("CLAUDESTRUCT_MODEL_DEFAULT", "qwen2.5-coder:32b")
    assert providers.default_model_for("openai") == "qwen2.5-coder:32b"
    assert providers.default_model_for("anthropic") == "qwen2.5-coder:32b"


# --- OpenAICompatProvider helpers -----------------------------------


def test_openai_build_messages_has_system_then_user():
    """No `cache_control` on the OpenAI path — wire format doesn't carry it."""
    msgs = providers.OpenAICompatProvider._build_messages("review", "look at this diff")
    assert len(msgs) == 2
    assert msgs[0]["role"] == "system"
    assert msgs[1]["role"] == "user"
    assert msgs[1]["content"] == "look at this diff"
    # Critical: the system block is a flat string, not a list of blocks
    # with cache_control. Caching is the wire-incompatible feature.
    assert isinstance(msgs[0]["content"], str)


def test_openai_count_tokens_falls_back_to_chars_div_4(monkeypatch):
    """When tiktoken isn't importable we still return a usable estimate."""
    monkeypatch.setenv("CLAUDESTRUCT_PROVIDER", "openai")

    # Stub the OpenAI SDK so the provider constructs.
    fake_module = MagicMock()
    fake_client = MagicMock()
    fake_module.OpenAI.return_value = fake_client
    monkeypatch.setitem(__import__("sys").modules, "openai", fake_module)

    # Block tiktoken's import to force the fallback path.
    import builtins
    real_import = builtins.__import__

    def fake_import(name, *args, **kwargs):
        if name == "tiktoken":
            raise ImportError("forced miss")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", fake_import)

    provider = providers.OpenAICompatProvider()
    n = provider.count_tokens(task="review", user_message="x" * 400, model="any")
    # The "review" system prompt is ~1.5k chars; combined with the
    # 400-char user message and the chars/4 heuristic, expect a few
    # hundred tokens. The exact number depends on the prompt text we
    # ship today, so the bound is loose to absorb future edits.
    assert n > 50
    assert n < 1000


def test_openai_run_task_streams_chunks_and_aggregates_usage(monkeypatch):
    """Streaming protocol: collect deltas, capture the last `usage` chunk."""
    monkeypatch.setenv("CLAUDESTRUCT_PROVIDER", "openai")

    fake_module = MagicMock()

    # Build a sequence of chunks shaped like OpenAI SDK streaming objects:
    # several delta chunks, then a final chunk that carries `usage`.
    def make_delta_chunk(text, finish=None):
        ch = MagicMock()
        ch.choices = [MagicMock(delta=MagicMock(content=text), finish_reason=finish)]
        ch.usage = None
        return ch

    def make_usage_chunk():
        ch = MagicMock()
        ch.choices = []  # final usage frame has no delta
        ch.usage = MagicMock(prompt_tokens=42, completion_tokens=10)
        return ch

    chunks = [
        make_delta_chunk("hello "),
        make_delta_chunk("world", finish="stop"),
        make_usage_chunk(),
    ]
    fake_client = MagicMock()
    fake_client.chat.completions.create.return_value = iter(chunks)
    fake_module.OpenAI.return_value = fake_client
    monkeypatch.setitem(__import__("sys").modules, "openai", fake_module)

    provider = providers.OpenAICompatProvider()
    streamed: list[str] = []
    result = provider.run_task(
        task="review", user_message="hi", model="gpt-fake",
        max_tokens=100, effort="high", stream_callback=streamed.append,
    )
    assert streamed == ["hello ", "world"]
    assert result["text"] == "hello world"
    assert result["input_tokens"] == 42
    assert result["output_tokens"] == 10
    assert result["cache_creation_tokens"] == 0
    assert result["cache_read_tokens"] == 0
    assert result["stop_reason"] == "stop"
    assert result["model"] == "gpt-fake"

    # `effort` was forwarded as `reasoning_effort` (OpenAI's name for it).
    kwargs = fake_client.chat.completions.create.call_args.kwargs
    assert kwargs["reasoning_effort"] == "high"
    assert kwargs["stream"] is True
    assert kwargs["stream_options"] == {"include_usage": True}


def test_openai_run_task_omits_reasoning_effort_when_absent(monkeypatch):
    """Local models without reasoning support shouldn't see an empty
    `reasoning_effort` field in the request."""
    monkeypatch.setenv("CLAUDESTRUCT_PROVIDER", "openai")
    fake_module = MagicMock()
    fake_client = MagicMock()
    fake_client.chat.completions.create.return_value = iter([])
    fake_module.OpenAI.return_value = fake_client
    monkeypatch.setitem(__import__("sys").modules, "openai", fake_module)

    provider = providers.OpenAICompatProvider()
    provider.run_task(
        task="review", user_message="hi", model="qwen2.5-coder:32b",
        max_tokens=100, effort=None, stream_callback=None,
    )
    kwargs = fake_client.chat.completions.create.call_args.kwargs
    assert "reasoning_effort" not in kwargs


def test_openai_provider_raises_when_sdk_missing(monkeypatch):
    """Soft-dep gating: `CLAUDESTRUCT_PROVIDER=openai` without the
    SDK installed should raise the `[openai]` extra hint."""
    import builtins
    real_import = builtins.__import__

    def block_openai(name, *args, **kwargs):
        if name == "openai":
            raise ImportError("missing")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", block_openai)
    with pytest.raises(providers._MissingDepError, match=r"openai\]"):
        providers.OpenAICompatProvider()


# --- AnthropicProvider invariants -----------------------------------


def test_anthropic_system_block_keeps_cache_breakpoint():
    """Critical regression guard: `cache_control: ephemeral` lives on
    the system block, otherwise the entire prompt-cache savings story
    evaporates."""
    # Construct the helper directly without instantiating the SDK.
    blocks = providers.AnthropicProvider._system_blocks(
        providers.AnthropicProvider.__new__(providers.AnthropicProvider),  # type: ignore[misc]
        "review",
    )
    assert len(blocks) == 1
    block = blocks[0]
    assert block["type"] == "text"
    assert block["cache_control"] == {"type": "ephemeral", "ttl": "1h"}
    # The text body must be the canonical system prompt — any per-call
    # noise here would silently invalidate the cache.
    from claudestruct.prompts import TASK_PROMPTS
    assert block["text"] == TASK_PROMPTS["review"]


def test_make_provider_dispatch(monkeypatch):
    """Selection plumbing: env-driven name picks the right class."""
    fake_anthropic_module = MagicMock()
    fake_anthropic_module.Anthropic.return_value = MagicMock()
    monkeypatch.setitem(__import__("sys").modules, "anthropic", fake_anthropic_module)
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test")
    monkeypatch.setenv("CLAUDESTRUCT_PROVIDER", "anthropic")

    p = providers.make_provider()
    assert isinstance(p, providers.AnthropicProvider)
    assert p.name == "anthropic"


def test_make_provider_explicit_name_overrides_env(monkeypatch):
    """Explicit arg wins so tests / library callers can pin a provider
    without disturbing process env."""
    monkeypatch.setenv("CLAUDESTRUCT_PROVIDER", "anthropic")
    fake_module = MagicMock()
    fake_module.OpenAI.return_value = MagicMock()
    monkeypatch.setitem(__import__("sys").modules, "openai", fake_module)

    p = providers.make_provider("openai")
    assert isinstance(p, providers.OpenAICompatProvider)
    assert p.name == "openai"


def test_record_cache_telemetry_warns_on_silent_miss(tmp_path, monkeypatch):
    """End-to-end smoke: telemetry returns a warning when the next
    call within TTL reads zero cached tokens for a known prompt."""
    # Redirect cache state file to a temp dir to avoid touching ~/.claudestruct.
    monkeypatch.setenv("CLAUDESTRUCT_HOME", str(tmp_path))
    # Prime: a successful write.
    providers.record_cache_telemetry(
        task="review", model="claude-opus-4-7",
        cache_creation=1000, cache_read=0,
    )
    # Follow-up: zero cache reads → should trigger a warning.
    warning = providers.record_cache_telemetry(
        task="review", model="claude-opus-4-7",
        cache_creation=0, cache_read=0,
    )
    assert warning is not None
    assert "cache miss" in warning.lower()
