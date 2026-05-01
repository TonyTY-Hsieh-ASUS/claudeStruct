"""Public client surface for claudestruct.

History: this module wrapped the Anthropic SDK directly. As of W10.1
the actual SDK call lives in ``providers.py`` (Anthropic + OpenAI-
compat); this file is the thin compatibility seam everything else in
the package imports from. Behavior on the Anthropic path is byte-
identical to the pre-W10.1 implementation.

Provider selection:
    CLAUDESTRUCT_PROVIDER=anthropic   (default; preserves prompt cache)
    CLAUDESTRUCT_PROVIDER=openai      (Ollama / vLLM / SGLang / cloud OpenAI)
    CLAUDESTRUCT_BASE_URL=http://...  (openai only; e.g. http://localhost:11434/v1)
    CLAUDESTRUCT_MODEL_DEFAULT=...    (overrides the per-provider default)

The Anthropic prompt-cache state machine (``cache_state.py``) only
fires on the Anthropic path — OpenAI-compat returns 0 cache tokens by
construction, so the silent-cache-miss detector stays quiet.
"""
from __future__ import annotations

from dataclasses import dataclass

from claudestruct import providers
from claudestruct.providers import (  # noqa: F401  (re-exported for back-compat)
    DEFAULT_HTTP_TIMEOUT_SECONDS,
    DEFAULT_MAX_RETRIES,
    _env_float,
    _env_int,
)

# `DEFAULT_MODEL` historically pointed at Anthropic's flagship. We keep
# the symbol pointing there for backwards compatibility (existing CLI
# `--model` defaults import this), but every fresh call should go
# through `providers.default_model_for(...)` so the OpenAI path picks
# a reasonable default when the env asks for it.
DEFAULT_MODEL = providers.DEFAULT_ANTHROPIC_MODEL
DEFAULT_MAX_TOKENS = 16000


class ClaudestructError(Exception):
    pass


@dataclass
class RunResult:
    text: str
    input_tokens: int
    output_tokens: int
    cache_creation_tokens: int
    cache_read_tokens: int
    stop_reason: str | None
    model: str
    cache_warning: str | None = None
    provider: str = "anthropic"

    @property
    def cached_fraction(self) -> float:
        total = self.input_tokens + self.cache_read_tokens + self.cache_creation_tokens
        if total == 0:
            return 0.0
        return self.cache_read_tokens / total


def _make_client():
    """Back-compat shim for callers (tests, external scripts) that
    instantiated the Anthropic SDK client directly. Returns the raw
    `anthropic.Anthropic` instance for the active provider when
    Anthropic is selected; raises `ClaudestructError` on missing
    creds. New code should call `run_task` / `count_tokens` instead.
    """
    name = providers.active_provider_name()
    try:
        provider = providers.make_provider(name)
    except providers._MissingCredsError as exc:
        raise ClaudestructError(str(exc)) from None
    except providers._MissingDepError as exc:
        raise ClaudestructError(str(exc)) from None
    # `_client` exists on both providers; the Anthropic case returns
    # the SDK instance the original `_make_client` did, the OpenAI
    # case returns the OpenAI SDK instance — both behave like the
    # underlying SDK clients.
    return provider._client


def _resolve_model(model: str | None) -> tuple[providers.Provider, str]:
    """Build the active provider and resolve a model name. Lets callers
    pass `None` and get the right default for whichever backend is
    selected — important so `cs dev` on an Ollama-pointed env doesn't
    silently try `claude-opus-4-7` against a local server."""
    name = providers.active_provider_name()
    try:
        provider = providers.make_provider(name)
    except providers._MissingCredsError as exc:
        raise ClaudestructError(str(exc)) from None
    except providers._MissingDepError as exc:
        raise ClaudestructError(str(exc)) from None
    resolved_model = model or providers.default_model_for(name)
    return provider, resolved_model


def count_tokens(task: str, user_message: str, model: str | None = None) -> int:
    """Count input tokens for a task without making the actual call.

    On Anthropic this hits `messages.count_tokens` (exact). On OpenAI-
    compat, falls back to tiktoken when available else a chars/4
    heuristic — accurate to ~10% for English code + prose, which is
    plenty for the dry-run preview.
    """
    from claudestruct.prompts import TASK_PROMPTS

    if task not in TASK_PROMPTS:
        raise ClaudestructError(
            f"Unknown task {task!r}. Valid tasks: {', '.join(TASK_PROMPTS)}"
        )
    provider, resolved_model = _resolve_model(model)
    return provider.count_tokens(
        task=task, user_message=user_message, model=resolved_model,
    )


def run_task(
    task: str,
    user_message: str,
    *,
    model: str | None = None,
    max_tokens: int = DEFAULT_MAX_TOKENS,
    effort: str | None = None,
    stream_callback=None,
) -> RunResult:
    """Run a task, streaming output via callback, and return usage stats.

    `stream_callback(text_chunk: str)` is invoked for each streamed text delta
    so the CLI can print live. If None, output is silent and only available in
    the returned RunResult.
    """
    from claudestruct.prompts import TASK_PROMPTS

    if task not in TASK_PROMPTS:
        raise ClaudestructError(
            f"Unknown task {task!r}. Valid tasks: {', '.join(TASK_PROMPTS)}"
        )

    provider, resolved_model = _resolve_model(model)
    raw = provider.run_task(
        task=task,
        user_message=user_message,
        model=resolved_model,
        max_tokens=max_tokens,
        effort=effort,
        stream_callback=stream_callback,
    )

    cache_creation = int(raw.get("cache_creation_tokens", 0) or 0)
    cache_read = int(raw.get("cache_read_tokens", 0) or 0)
    # Cache telemetry is only meaningful on the Anthropic path; on the
    # OpenAI-compat path both numbers are zero by construction so the
    # silent-miss detector stays quiet without an explicit branch.
    warning = providers.record_cache_telemetry(
        task=task, model=resolved_model,
        cache_creation=cache_creation, cache_read=cache_read,
    )
    return RunResult(
        text=raw["text"],
        input_tokens=int(raw.get("input_tokens", 0) or 0),
        output_tokens=int(raw.get("output_tokens", 0) or 0),
        cache_creation_tokens=cache_creation,
        cache_read_tokens=cache_read,
        stop_reason=raw.get("stop_reason"),
        model=raw.get("model") or resolved_model,
        cache_warning=warning,
        provider=provider.name,
    )


def build_user_message(task_description: str, context_render: str) -> str:
    """Compose the user turn: instruction first, then the context block.

    Keeping the task description first makes it easy for the model to
    latch onto the intent before reading through potentially large context.
    """
    parts = [task_description.strip()]
    if context_render.strip():
        parts.append("")
        parts.append("---")
        parts.append("")
        parts.append(context_render)
    return "\n".join(parts)


# Back-compat: a few external callers reach in for these helpers. Re-
# export so we don't break anyone's import on this refactor.
__all__ = [
    "DEFAULT_MODEL",
    "DEFAULT_MAX_TOKENS",
    "DEFAULT_HTTP_TIMEOUT_SECONDS",
    "DEFAULT_MAX_RETRIES",
    "ClaudestructError",
    "RunResult",
    "count_tokens",
    "run_task",
    "build_user_message",
]
