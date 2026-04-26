"""Pure-Python task runner — no Click, no Rich, no `sys.exit`.

This is the body the CLI's `_run_common` would have if it didn't also
have to render Rich tables and call Click's exit shims. Both the CLI
and the MCP server (F1) call into this so the business logic stays in
one place. The CLI wraps it with progress rendering; the MCP server
wraps it with structured tool responses.

What lives here:
  - context gather + budget enforcement
  - structured JSONL event emission (auto-log + optional --log-json mirror)
  - the actual `run_task` call against the Anthropic SDK
  - cost accounting

What does NOT live here:
  - sys.exit / Click decorators (CLI concern)
  - Rich Console rendering (CLI concern)
  - dry-run, show-context shortcuts (caller-specific UX)
  - monthly-cap warning UX (caller renders; this layer raises)
"""
from __future__ import annotations

import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

from claudestruct import dashboard, tracing
from claudestruct import logging as event_log
from claudestruct.client import (
    DEFAULT_MAX_TOKENS,
    DEFAULT_MODEL,
    ClaudestructError,
    RunResult,
    build_user_message,
    run_task,
)
from claudestruct.context import BUDGETS_PER_TASK
from claudestruct.cost import estimate_cost_usd
from claudestruct.prompts import TASK_PROMPT_VERSIONS


@dataclass
class TaskRunOutcome:
    """Result of `run_task_and_log` — the LLM's `RunResult` plus the
    accounting numbers downstream consumers (CLI summary, MCP response,
    dashboard) all want."""

    result: RunResult
    cost_usd: float
    duration_ms: int
    context_files: int
    context_total_bytes: int
    auto_log_path: Path


def run_task_and_log(
    task: str,
    description: str,
    paths: list[Path] | None,
    root: Path,
    *,
    gatherer: Callable,
    model: str = DEFAULT_MODEL,
    max_tokens: int = DEFAULT_MAX_TOKENS,
    effort: str | None = None,
    max_bytes: int | None = None,
    log_json: str | None = None,
    on_chunk: Callable[[str], None] | None = None,
    redactor: object | None = None,
) -> TaskRunOutcome:
    """Run one task, emit structured events, return the outcome.

    ``redactor`` (a ``claudestruct.redact.Redactor``) is applied to
    every event before it lands on disk. Pass ``None`` to disable.

    Raises `ClaudestructError` on API key / unknown task / network
    errors — caller decides how to surface those (Click prints + exits;
    MCP raises into a structured tool error).
    """
    # Tracing is opt-in via OTEL_EXPORTER_OTLP_ENDPOINT. init_tracing()
    # is idempotent and zero-cost when disabled, so we can call it on
    # every task run rather than threading state through the CLI.
    tracing.init_tracing()

    with tracing.span(
        "claudestruct.task",
        attributes={
            "claudestruct.task": task,
            "claudestruct.model": model,
            "claudestruct.effort": effort,
            "claudestruct.prompt_version": TASK_PROMPT_VERSIONS.get(task),
        },
    ) as task_span:
        budget = max_bytes if max_bytes is not None else BUDGETS_PER_TASK.get(task, 600_000)
        with tracing.span(
            "claudestruct.context_gather",
            attributes={"claudestruct.budget_bytes": budget},
        ) as ctx_span:
            ctx = gatherer(root=root, explicit_paths=paths, max_total_bytes=budget)
            ctx_span.set_attribute("claudestruct.files", len(ctx.files))
            ctx_span.set_attribute("claudestruct.total_bytes", ctx.total_bytes)
        user_msg = build_user_message(description, ctx.render())

        started = time.monotonic()
        auto_path = dashboard.auto_log_path(root)
        # `redactor` from W5.3 (PII / secret stripping) flows through the
        # fanout sink so both the auto-log AND the optional --log-json
        # mirror get scrubbed in one pass before disk write.
        with event_log.fanout_log([str(auto_path), log_json], redactor=redactor) as sink:
            sink.write(event_log.run_start(
                task=task,
                model=model,
                effort=effort,
                prompt_version=TASK_PROMPT_VERSIONS.get(task),
            ))
            try:
                with tracing.span(
                    "claudestruct.llm_call",
                    attributes={"claudestruct.model": model},
                ) as call_span:
                    result = run_task(
                        task,
                        user_msg,
                        model=model,
                        max_tokens=max_tokens,
                        effort=effort,
                        stream_callback=on_chunk,
                    )
                    call_span.set_attribute("claudestruct.input_tokens", result.input_tokens)
                    call_span.set_attribute("claudestruct.output_tokens", result.output_tokens)
                    call_span.set_attribute("claudestruct.cache_read_tokens", result.cache_read_tokens)
                    call_span.set_attribute("claudestruct.cache_creation_tokens", result.cache_creation_tokens)
            except ClaudestructError:
                sink.write(event_log.run_end(
                    reason="error",
                    duration_ms=int((time.monotonic() - started) * 1000),
                    total_cost_usd=0.0,
                ))
                raise
            cost = estimate_cost_usd(
                model=result.model,
                input_tokens=result.input_tokens,
                output_tokens=result.output_tokens,
                cache_read_tokens=result.cache_read_tokens,
                cache_creation_tokens=result.cache_creation_tokens,
            )
            sink.write(event_log.agent_usage(
                role="claudestruct",
                provider="anthropic",
                model=result.model,
                input_tokens=result.input_tokens,
                output_tokens=result.output_tokens,
                cache_read_tokens=result.cache_read_tokens,
                cache_creation_tokens=result.cache_creation_tokens,
                cost_usd=cost,
            ))
            if result.cache_warning:
                sink.write(event_log.cache_warning(result.cache_warning))
            duration_ms = int((time.monotonic() - started) * 1000)
            sink.write(event_log.run_end(
                reason=result.stop_reason or "complete",
                duration_ms=duration_ms,
                total_cost_usd=cost,
            ))
            task_span.set_attribute("claudestruct.cost_usd", cost)
            task_span.set_attribute("claudestruct.duration_ms", duration_ms)

    return TaskRunOutcome(
        result=result,
        cost_usd=cost,
        duration_ms=duration_ms,
        context_files=len(ctx.files),
        context_total_bytes=ctx.total_bytes,
        auto_log_path=auto_path,
    )
