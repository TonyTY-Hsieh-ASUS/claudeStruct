"""Provider abstraction for claudestruct (W10.1).

Supports two backends behind the same `run_task` / `count_tokens` API:

  * **Anthropic native** (default) — preserves the prompt-cache semantics
    that make `cs` cheap on cloud Claude. ``cache_control: ephemeral``
    on the system block, adaptive thinking, effort knob.
  * **OpenAI-compatible** — speaks the OpenAI chat-completions wire
    format with an arbitrary `base_url`. Targets local servers
    (Ollama / vLLM / SGLang / llama.cpp), the GX10 unified-memory
    workstation case, and any cloud OpenAI-shape API. No prompt
    cache (the wire format doesn't carry the breakpoint).

Selection at runtime via env (matches the `CLAW_SQUAD_*` precedent):

    CLAUDESTRUCT_PROVIDER         "anthropic" (default) | "openai"
    CLAUDESTRUCT_BASE_URL         override base URL (openai only)
    CLAUDESTRUCT_MODEL_DEFAULT    override DEFAULT_MODEL (handy on local)

The two providers diverge on what `usage` carries: Anthropic emits
`cache_{creation,read}_input_tokens`; OpenAI-compat emits flat
`prompt_tokens` / `completion_tokens`. We fold into the same
``RunResult`` shape with cache fields = 0 on the OpenAI path so the
existing dashboard / metrics code continues to work without branches.

Why a separate module instead of growing client.py:
  - Keeps the Anthropic-specific prompt-cache logic exactly where it
    is (no behavior change on the cloud path).
  - The OpenAI SDK is now a soft dep — declared as a `[openai]` extra
    so the lean install isn't 30 MB heavier.
"""
from __future__ import annotations

import os
from collections.abc import Callable
from typing import Any, Protocol

from claudestruct import cache_state
from claudestruct.prompts import TASK_EFFORT, TASK_PROMPTS

DEFAULT_ANTHROPIC_MODEL = "claude-opus-4-7"
DEFAULT_OPENAI_MODEL = "gpt-4o-mini"
DEFAULT_HTTP_TIMEOUT_SECONDS = 300.0
DEFAULT_MAX_RETRIES = 3


def _env_float(name: str, default: float) -> float:
    raw = os.environ.get(name)
    if raw is None or raw == "":
        return default
    try:
        return float(raw)
    except ValueError:
        return default


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None or raw == "":
        return default
    try:
        return int(raw)
    except ValueError:
        return default


class Provider(Protocol):
    """Minimum surface a backend has to implement.

    `run_task` is the streaming inference call; `count_tokens` is the
    `--dry-run` cost-preview path. Both return primitive types so the
    caller doesn't need to import provider-specific SDKs.
    """

    name: str

    def count_tokens(self, *, task: str, user_message: str, model: str) -> int: ...

    def run_task(
        self,
        *,
        task: str,
        user_message: str,
        model: str,
        max_tokens: int,
        effort: str | None,
        stream_callback: Callable[[str], None] | None,
    ) -> dict[str, Any]:
        """Returns dict with keys: text, input_tokens, output_tokens,
        cache_creation_tokens, cache_read_tokens, stop_reason, model.
        """


# --- Anthropic ------------------------------------------------------


class AnthropicProvider:
    name = "anthropic"

    def __init__(self) -> None:
        from claudestruct import secrets as secrets_mod

        api_key = secrets_mod.get("anthropic.api_key")
        if not api_key:
            raise _MissingCredsError(
                "ANTHROPIC_API_KEY is not set. Export it in your shell, store it in "
                "your OS keychain (`keyring set claudestruct anthropic.api_key`), "
                "or in `pass` and set CLAUDESTRUCT_SECRETS_PROVIDER=keyring,pass."
            )
        # Lazy import so the OpenAI-only install path doesn't need the
        # anthropic SDK.
        import anthropic

        timeout = _env_float("CLAUDESTRUCT_TIMEOUT", DEFAULT_HTTP_TIMEOUT_SECONDS)
        max_retries = _env_int("CLAUDESTRUCT_MAX_RETRIES", DEFAULT_MAX_RETRIES)
        self._client = anthropic.Anthropic(
            api_key=api_key, timeout=timeout, max_retries=max_retries,
        )

    def _system_blocks(self, task: str) -> list[dict]:
        # Single cache_control breakpoint on the final (only) block
        # caches the entire system prefix at 1h TTL.
        return [{
            "type": "text",
            "text": TASK_PROMPTS[task],
            "cache_control": {"type": "ephemeral", "ttl": "1h"},
        }]

    def count_tokens(self, *, task: str, user_message: str, model: str) -> int:
        resp = self._client.messages.count_tokens(
            model=model,
            system=self._system_blocks(task),
            messages=[{"role": "user", "content": user_message}],
        )
        return resp.input_tokens

    def run_task(
        self, *, task, user_message, model, max_tokens, effort, stream_callback,
    ) -> dict[str, Any]:
        effort_value = effort or TASK_EFFORT[task]
        collected: list[str] = []
        with self._client.messages.stream(
            model=model,
            max_tokens=max_tokens,
            system=self._system_blocks(task),
            thinking={"type": "adaptive"},
            output_config={"effort": effort_value},
            messages=[{"role": "user", "content": user_message}],
        ) as stream:
            for text in stream.text_stream:
                collected.append(text)
                if stream_callback is not None:
                    stream_callback(text)
            final = stream.get_final_message()

        usage = final.usage
        return {
            "text": "".join(collected),
            "input_tokens": usage.input_tokens,
            "output_tokens": usage.output_tokens,
            "cache_creation_tokens": getattr(usage, "cache_creation_input_tokens", 0) or 0,
            "cache_read_tokens": getattr(usage, "cache_read_input_tokens", 0) or 0,
            "stop_reason": final.stop_reason,
            "model": final.model,
        }


# --- OpenAI-compatible ----------------------------------------------


class OpenAICompatProvider:
    """Speaks the OpenAI chat-completions wire format.

    Targets:
      - Ollama (`http://localhost:11434/v1`)
      - vLLM (`http://localhost:8000/v1`)
      - SGLang (`http://localhost:30000/v1`)
      - cloud OpenAI / Anthropic-via-OpenAI-shim / any compatible
        endpoint via `CLAUDESTRUCT_BASE_URL`

    Auth: looks up `openai.api_key` via the secrets module first, then
    falls back to `CLAUDESTRUCT_API_KEY` env. For local servers that
    accept any string, sets a benign placeholder so the OpenAI SDK
    doesn't refuse to construct the client.
    """

    name = "openai"

    def __init__(self) -> None:
        # Lazy import so anthropic-only installs don't need the openai SDK.
        try:
            from openai import OpenAI
        except ImportError as exc:
            raise _MissingDepError(
                "CLAUDESTRUCT_PROVIDER=openai requires the openai SDK. "
                "Install via `pip install claudestruct[openai]`."
            ) from exc

        from claudestruct import secrets as secrets_mod

        api_key = (
            secrets_mod.get("openai.api_key")
            or os.environ.get("CLAUDESTRUCT_API_KEY", "").strip()
            or "sk-local-no-auth"  # local servers ignore this
        )
        base_url = os.environ.get("CLAUDESTRUCT_BASE_URL", "").strip() or None
        timeout = _env_float("CLAUDESTRUCT_TIMEOUT", DEFAULT_HTTP_TIMEOUT_SECONDS)
        max_retries = _env_int("CLAUDESTRUCT_MAX_RETRIES", DEFAULT_MAX_RETRIES)

        kwargs: dict[str, Any] = {
            "api_key": api_key, "timeout": timeout, "max_retries": max_retries,
        }
        if base_url:
            kwargs["base_url"] = base_url
        self._client = OpenAI(**kwargs)

    @staticmethod
    def _build_messages(task: str, user_message: str) -> list[dict[str, str]]:
        # No cache_control on the system block — the OpenAI wire format
        # doesn't have a breakpoint. Servers like Ollama do their own
        # internal caching but it's transparent to the client.
        return [
            {"role": "system", "content": TASK_PROMPTS[task]},
            {"role": "user", "content": user_message},
        ]

    def count_tokens(self, *, task: str, user_message: str, model: str) -> int:
        # The OpenAI HTTP API doesn't expose a remote token counter for
        # arbitrary models. Use tiktoken when available; fall back to
        # a chars/4 heuristic that's good to ~10% on English code +
        # tech writing. Local servers (Ollama / vLLM) frequently lack
        # a /v1/tokenize endpoint at all, so we don't try one.
        text = TASK_PROMPTS[task] + "\n" + user_message
        try:
            import tiktoken  # type: ignore
        except ImportError:
            return max(1, len(text) // 4)
        try:
            enc = tiktoken.encoding_for_model(model)
        except KeyError:
            enc = tiktoken.get_encoding("cl100k_base")
        return len(enc.encode(text))

    def run_task(
        self, *, task, user_message, model, max_tokens, effort, stream_callback,
    ) -> dict[str, Any]:
        # `effort` maps to OpenAI's `reasoning_effort` on reasoning
        # models (gpt-5 / o-series). Local models silently ignore
        # unknown fields, so always pass it when set.
        kwargs: dict[str, Any] = {
            "model": model,
            "messages": self._build_messages(task, user_message),
            "max_tokens": max_tokens,
            "stream": True,
            # `stream_options` asks the server to include the final
            # usage block in the last chunk — Ollama / vLLM both
            # honor this; cloud OpenAI does too.
            "stream_options": {"include_usage": True},
        }
        if effort:
            kwargs["reasoning_effort"] = effort

        collected: list[str] = []
        usage_obj: Any = None
        finish_reason: str | None = None
        for chunk in self._client.chat.completions.create(**kwargs):
            choices = getattr(chunk, "choices", None) or []
            if choices:
                delta = getattr(choices[0], "delta", None)
                content = getattr(delta, "content", None) if delta else None
                if content:
                    collected.append(content)
                    if stream_callback is not None:
                        stream_callback(content)
                fr = getattr(choices[0], "finish_reason", None)
                if fr:
                    finish_reason = fr
            chunk_usage = getattr(chunk, "usage", None)
            if chunk_usage is not None:
                usage_obj = chunk_usage

        prompt_tokens = int(getattr(usage_obj, "prompt_tokens", 0) or 0)
        completion_tokens = int(getattr(usage_obj, "completion_tokens", 0) or 0)
        return {
            "text": "".join(collected),
            "input_tokens": prompt_tokens,
            "output_tokens": completion_tokens,
            # OpenAI-compat has no per-call cache breakdown; report 0
            # so cost / cache-warning logic gracefully no-ops.
            "cache_creation_tokens": 0,
            "cache_read_tokens": 0,
            "stop_reason": finish_reason,
            "model": model,
        }


# --- Selection ------------------------------------------------------


class _MissingCredsError(RuntimeError):
    pass


class _MissingDepError(RuntimeError):
    pass


def active_provider_name() -> str:
    """Resolve the configured provider name. Defaults to anthropic so
    pre-W10.1 callers see no behavior change."""
    raw = os.environ.get("CLAUDESTRUCT_PROVIDER", "anthropic").strip().lower()
    if raw in {"anthropic", "openai"}:
        return raw
    # Unknown values fall back to anthropic rather than blowing up at
    # import time — surfaces as a clearer error when the actual call
    # fails on missing creds, and keeps `CLAUDESTRUCT_PROVIDER` typos
    # from breaking unrelated commands.
    return "anthropic"


def default_model_for(provider_name: str) -> str:
    """Pick a sane default model per provider.

    Override globally via ``CLAUDESTRUCT_MODEL_DEFAULT`` so a GX10
    user can put `qwen2.5-coder:32b` in their shell profile and never
    type it again."""
    override = os.environ.get("CLAUDESTRUCT_MODEL_DEFAULT", "").strip()
    if override:
        return override
    if provider_name == "openai":
        return DEFAULT_OPENAI_MODEL
    return DEFAULT_ANTHROPIC_MODEL


def make_provider(name: str | None = None) -> Provider:
    """Construct the active provider. Tests pass ``name`` explicitly;
    runtime calls leave it None to read env."""
    chosen = name or active_provider_name()
    if chosen == "openai":
        return OpenAICompatProvider()
    return AnthropicProvider()


# --- Re-export the constants the rest of the package consumed --------

# Existing call sites in client.py / runner.py import these symbols
# straight from `claudestruct.client`. Keep them there — this module
# is the implementation seam, not the public API.
def record_cache_telemetry(*, task: str, model: str, cache_creation: int,
                           cache_read: int) -> str | None:
    """Run the cache-state bookkeeping that used to live inline in
    `run_task`. Returns the optional warning string."""
    p_hash = cache_state.prompt_hash(TASK_PROMPTS[task])
    warning = cache_state.check_for_silent_miss(
        task=task, model=model, current_prompt_hash=p_hash,
        cache_read_tokens=cache_read,
    )
    cache_state.record_cache_write(
        task=task, model=model, current_prompt_hash=p_hash,
        cache_creation_tokens=cache_creation, cache_read_tokens=cache_read,
    )
    return warning
