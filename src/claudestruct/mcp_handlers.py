"""MCP tool handlers — pure dict-in / dict-out, no MCP SDK imports.

Decoupling the handlers from the MCP server bootstrap means:
  - We can unit-test them without spinning up stdio transport.
  - The handlers are reusable from any future surface (HTTP API,
    Slack bot, etc.) — same function calls, different transport.
  - Importing this module never pulls in the heavy `mcp` package.

Each handler accepts a JSON-friendly dict (validated with explicit
field defaults), calls into `runner.run_task_and_log` or the
`dashboard` / `metrics` modules, and returns a JSON-friendly dict.
Errors raise `ClaudestructError` (or `KeyError` for missing required
fields); the server bootstrap maps them to MCP-level error responses.
"""
from __future__ import annotations

from collections.abc import Callable
from pathlib import Path
from typing import Any

from claudestruct import dashboard, metrics
from claudestruct.client import DEFAULT_MAX_TOKENS, DEFAULT_MODEL, ClaudestructError
from claudestruct.context import (
    gather_debug_context,
    gather_dev_context,
    gather_plan_context,
    gather_review_context,
)
from claudestruct.runner import run_task_and_log

_GATHERERS: dict[str, Callable] = {
    "dev": gather_dev_context,
    "review": gather_review_context,
    "plan": gather_plan_context,
    "debug": gather_debug_context,
}


def _resolve_root(root: str | None) -> Path:
    return Path(root).resolve() if root else Path.cwd()


def _result_to_dict(outcome) -> dict[str, Any]:
    r = outcome.result
    return {
        "text": r.text,
        "model": r.model,
        "stopReason": r.stop_reason,
        "inputTokens": r.input_tokens,
        "outputTokens": r.output_tokens,
        "cacheReadTokens": r.cache_read_tokens,
        "cacheCreationTokens": r.cache_creation_tokens,
        "costUsd": round(outcome.cost_usd, 6),
        "durationMs": outcome.duration_ms,
        "contextFiles": outcome.context_files,
        "contextBytes": outcome.context_total_bytes,
        "cacheWarning": r.cache_warning,
    }


def _run_task_handler(task: str, args: dict[str, Any]) -> dict[str, Any]:
    """Shared body for the four task handlers — they only differ in the
    task name and which gatherer to run."""
    description = args.get("description")
    if not description:
        raise ValueError(f"claudestruct_{task}: 'description' is required")
    root = _resolve_root(args.get("root"))
    paths_arg = args.get("paths")
    paths: list[Path] | None = None
    if paths_arg:
        if not isinstance(paths_arg, list):
            raise ValueError(f"claudestruct_{task}: 'paths' must be a list of strings")
        paths = [Path(p) if Path(p).is_absolute() else (root / p) for p in paths_arg]
    outcome = run_task_and_log(
        task=task,
        description=str(description),
        paths=paths,
        root=root,
        gatherer=_GATHERERS[task],
        model=args.get("model") or DEFAULT_MODEL,
        max_tokens=int(args.get("max_tokens") or DEFAULT_MAX_TOKENS),
        effort=args.get("effort"),
        max_bytes=args.get("max_bytes"),
    )
    return _result_to_dict(outcome)


def handle_dev(args: dict[str, Any]) -> dict[str, Any]:
    return _run_task_handler("dev", args)


def handle_review(args: dict[str, Any]) -> dict[str, Any]:
    return _run_task_handler("review", args)


def handle_plan(args: dict[str, Any]) -> dict[str, Any]:
    return _run_task_handler("plan", args)


def handle_debug(args: dict[str, Any]) -> dict[str, Any]:
    return _run_task_handler("debug", args)


def handle_dashboard(args: dict[str, Any]) -> dict[str, Any]:
    """List recent runs from `<root>/.claudestruct/runs/`."""
    root = _resolve_root(args.get("root"))
    summaries = dashboard.load_summaries(root)
    task = args.get("task")
    if task:
        summaries = dashboard.filter_summaries(summaries, task=str(task))
    limit = int(args.get("limit") or 20)
    rows = summaries[-limit:]
    return {
        "runs": [
            {
                "runId": s.run_id,
                "startedAt": s.started_at,
                "endedAt": s.ended_at,
                "task": s.task,
                "model": s.model,
                "effort": s.effort,
                "promptVersion": s.prompt_version,
                "reason": s.reason,
                "durationMs": s.duration_ms,
                "inputTokens": s.input_tokens,
                "outputTokens": s.output_tokens,
                "cacheReadTokens": s.cache_read_tokens,
                "cacheCreationTokens": s.cache_creation_tokens,
                "costUsd": round(s.cost_usd, 6),
                "cacheWarnings": s.cache_warnings,
            }
            for s in rows
        ],
        "count": len(rows),
        "totalAvailable": len(summaries),
    }


def handle_metrics(args: dict[str, Any]) -> dict[str, Any]:
    """Return the Prometheus exposition for the run history."""
    root = _resolve_root(args.get("root"))
    summaries = dashboard.load_summaries(root)
    return {"prometheus": metrics.render_prometheus(summaries)}


# Tool catalog used by the server bootstrap to register list_tools().
# Keep schemas tight so MCP clients (Claude Code, etc.) can reason
# about the args without trial and error.
TOOL_SCHEMAS: list[dict[str, Any]] = [
    {
        "name": "claudestruct_dev",
        "description": (
            "Run claudestruct's `dev` task — propose a minimal code change "
            "with cached system prompt and git-smart context."
        ),
        "inputSchema": {
            "type": "object",
            "required": ["description"],
            "properties": {
                "description": {"type": "string"},
                "paths": {"type": "array", "items": {"type": "string"}},
                "root": {"type": "string"},
                "model": {"type": "string"},
                "effort": {
                    "type": "string",
                    "enum": ["low", "medium", "high", "xhigh", "max"],
                },
                "max_tokens": {"type": "integer"},
                "max_bytes": {"type": "integer"},
            },
        },
    },
    {
        "name": "claudestruct_review",
        "description": (
            "Run claudestruct's `review` task — structured code review of "
            "the current branch diff or specified files."
        ),
        "inputSchema": {
            "type": "object",
            "required": ["description"],
            "properties": {
                "description": {"type": "string"},
                "paths": {"type": "array", "items": {"type": "string"}},
                "root": {"type": "string"},
                "model": {"type": "string"},
                "effort": {
                    "type": "string",
                    "enum": ["low", "medium", "high", "xhigh", "max"],
                },
                "max_tokens": {"type": "integer"},
                "max_bytes": {"type": "integer"},
            },
        },
    },
    {
        "name": "claudestruct_plan",
        "description": (
            "Run claudestruct's `plan` task — architecture/implementation "
            "planning with deep reasoning."
        ),
        "inputSchema": {
            "type": "object",
            "required": ["description"],
            "properties": {
                "description": {"type": "string"},
                "paths": {"type": "array", "items": {"type": "string"}},
                "root": {"type": "string"},
                "model": {"type": "string"},
                "effort": {
                    "type": "string",
                    "enum": ["low", "medium", "high", "xhigh", "max"],
                },
                "max_tokens": {"type": "integer"},
                "max_bytes": {"type": "integer"},
            },
        },
    },
    {
        "name": "claudestruct_debug",
        "description": (
            "Run claudestruct's `debug` task — hypothesis-ranked debugging "
            "anchored on an error message."
        ),
        "inputSchema": {
            "type": "object",
            "required": ["description"],
            "properties": {
                "description": {"type": "string"},
                "paths": {"type": "array", "items": {"type": "string"}},
                "root": {"type": "string"},
                "model": {"type": "string"},
                "effort": {
                    "type": "string",
                    "enum": ["low", "medium", "high", "xhigh", "max"],
                },
                "max_tokens": {"type": "integer"},
                "max_bytes": {"type": "integer"},
            },
        },
    },
    {
        "name": "claudestruct_dashboard",
        "description": (
            "Return recent claudestruct runs from .claudestruct/runs/. "
            "Useful for cost tracking and cache-hit-rate analysis."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "root": {"type": "string"},
                "task": {
                    "type": "string",
                    "enum": ["dev", "review", "plan", "debug"],
                },
                "limit": {"type": "integer"},
            },
        },
    },
    {
        "name": "claudestruct_metrics",
        "description": (
            "Return Prometheus text-format metrics aggregated from "
            ".claudestruct/runs/ for ingestion by node_exporter / Grafana."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "root": {"type": "string"},
            },
        },
    },
]


HANDLERS: dict[str, Callable[[dict[str, Any]], dict[str, Any]]] = {
    "claudestruct_dev": handle_dev,
    "claudestruct_review": handle_review,
    "claudestruct_plan": handle_plan,
    "claudestruct_debug": handle_debug,
    "claudestruct_dashboard": handle_dashboard,
    "claudestruct_metrics": handle_metrics,
}


__all__ = [
    "ClaudestructError",
    "HANDLERS",
    "TOOL_SCHEMAS",
    "handle_debug",
    "handle_dashboard",
    "handle_dev",
    "handle_metrics",
    "handle_plan",
    "handle_review",
]
