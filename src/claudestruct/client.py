"""Anthropic client wrapper with prompt caching and streaming.

Efficiency design:
- System prompt per task is FROZEN and marked with cache_control ephemeral
  (1h TTL). After the first call, cached reads cost ~10% of normal input.
- User turn carries the volatile content (task description + collected
  context). Never placed in the system prompt.
- Streaming is always on — avoids SDK HTTP timeouts at high max_tokens and
  gives the user live feedback.
- Adaptive thinking is the default; effort is tunable per task.
- Model is `claude-opus-4-7` by default (most capable); callable can override.

The token savings from caching compound: across 10 calls with the same task
type, total input tokens cost ~1.9x the system prompt size instead of 10x.
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Iterator

import anthropic

from claudestruct import cache_state
from claudestruct.prompts import TASK_EFFORT, TASK_PROMPTS

DEFAULT_MODEL = "claude-opus-4-7"
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

    @property
    def cached_fraction(self) -> float:
        total = self.input_tokens + self.cache_read_tokens + self.cache_creation_tokens
        if total == 0:
            return 0.0
        return self.cache_read_tokens / total


def _make_client() -> anthropic.Anthropic:
    if not os.environ.get("ANTHROPIC_API_KEY"):
        raise ClaudestructError(
            "ANTHROPIC_API_KEY is not set. Export it in your shell or put it in a .env."
        )
    return anthropic.Anthropic()


def _system_blocks(task: str) -> list[dict]:
    """Build the cached system prompt for a task.

    Placing the only cache_control breakpoint on the final block caches the
    entire system prefix (plus any tools rendered before it, if we add any
    later). 1h TTL because dev sessions commonly span more than 5 minutes.
    """
    system_text = TASK_PROMPTS[task]
    return [
        {
            "type": "text",
            "text": system_text,
            "cache_control": {"type": "ephemeral", "ttl": "1h"},
        }
    ]


def count_tokens(task: str, user_message: str, model: str = DEFAULT_MODEL) -> int:
    client = _make_client()
    resp = client.messages.count_tokens(
        model=model,
        system=_system_blocks(task),
        messages=[{"role": "user", "content": user_message}],
    )
    return resp.input_tokens


def run_task(
    task: str,
    user_message: str,
    *,
    model: str = DEFAULT_MODEL,
    max_tokens: int = DEFAULT_MAX_TOKENS,
    effort: str | None = None,
    stream_callback=None,
) -> RunResult:
    """Run a task, streaming output via callback, and return usage stats.

    `stream_callback(text_chunk: str)` is invoked for each streamed text delta
    so the CLI can print live. If None, output is silent and only available in
    the returned RunResult.
    """
    if task not in TASK_PROMPTS:
        raise ClaudestructError(
            f"Unknown task {task!r}. Valid tasks: {', '.join(TASK_PROMPTS)}"
        )
    client = _make_client()
    effort_value = effort or TASK_EFFORT[task]

    collected: list[str] = []
    with client.messages.stream(
        model=model,
        max_tokens=max_tokens,
        system=_system_blocks(task),
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
    cache_creation = getattr(usage, "cache_creation_input_tokens", 0) or 0
    cache_read = getattr(usage, "cache_read_input_tokens", 0) or 0
    p_hash = cache_state.prompt_hash(TASK_PROMPTS[task])
    warning = cache_state.check_for_silent_miss(
        task=task,
        model=model,
        current_prompt_hash=p_hash,
        cache_read_tokens=cache_read,
    )
    cache_state.record_cache_write(
        task=task,
        model=model,
        current_prompt_hash=p_hash,
        cache_creation_tokens=cache_creation,
        cache_read_tokens=cache_read,
    )
    return RunResult(
        text="".join(collected),
        input_tokens=usage.input_tokens,
        output_tokens=usage.output_tokens,
        cache_creation_tokens=cache_creation,
        cache_read_tokens=cache_read,
        stop_reason=final.stop_reason,
        model=final.model,
        cache_warning=warning,
    )


def build_user_message(task_description: str, context_render: str) -> str:
    """Compose the user turn: instruction first, then the context block.

    Keeping the task description first makes it easy for Claude to latch onto
    the intent before reading through potentially large context.
    """
    parts = [task_description.strip()]
    if context_render.strip():
        parts.append("")
        parts.append("---")
        parts.append("")
        parts.append(context_render)
    return "\n".join(parts)
