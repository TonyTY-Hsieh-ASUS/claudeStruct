"""claudestruct CLI — token-efficient companion for Claude Code workflows.

Subcommands:
  cs dev      — development task with smart context collection
  cs review   — code review on the current branch's diff, or specified files
  cs plan     — architecture/planning mode
  cs debug    — debugging mode, anchored on an error message
  cs tokens   — count tokens for a dry-run without sending a request
  cs context  — print the context that would be gathered, without calling Claude
"""
from __future__ import annotations

import sys
from pathlib import Path
from typing import Callable

import click
from rich.console import Console
from rich.table import Table

from claudestruct import __version__
from claudestruct.client import (
    DEFAULT_MAX_TOKENS,
    DEFAULT_MODEL,
    ClaudestructError,
    build_user_message,
    count_tokens,
    run_task,
)
from claudestruct.context import (
    gather_debug_context,
    gather_dev_context,
    gather_plan_context,
    gather_review_context,
)
from claudestruct.cost import estimate_cost_usd
from claudestruct import logging as event_log
from claudestruct.prompts import TASK_PROMPT_VERSIONS

console = Console()
err = Console(stderr=True)


GATHERERS: dict[str, Callable] = {
    "dev": gather_dev_context,
    "review": gather_review_context,
    "plan": gather_plan_context,
    "debug": gather_debug_context,
}


def _resolve_root(root_opt: str | None) -> Path:
    if root_opt:
        return Path(root_opt).resolve()
    return Path.cwd()


def _render_usage(result, task: str) -> None:
    table = Table(title="Token usage", show_header=True, header_style="bold")
    table.add_column("metric", style="cyan")
    table.add_column("tokens", justify="right")
    table.add_row("input (uncached)", f"{result.input_tokens:,}")
    table.add_row("cache read (~0.1x cost)", f"{result.cache_read_tokens:,}")
    table.add_row("cache write (~1.25-2x cost)", f"{result.cache_creation_tokens:,}")
    table.add_row("output", f"{result.output_tokens:,}")
    pct = result.cached_fraction * 100
    err.print(table)
    err.print(f"[dim]cached fraction of input: {pct:.1f}%[/dim]")
    err.print(f"[dim]model: {result.model} | stop: {result.stop_reason}[/dim]")
    err.print(f"[dim]prompt: {_prompt_label(task)}[/dim]")
    if result.cache_warning:
        err.print(f"[yellow]warning:[/yellow] {result.cache_warning}")


def _render_context_summary(ctx) -> None:
    table = Table(title="Context", show_header=True, header_style="bold")
    table.add_column("file", style="cyan")
    table.add_column("bytes", justify="right")
    for f in ctx.files:
        table.add_row(f.rel, f"{f.bytes:,}")
    err.print(table)
    err.print(f"[dim]total: {ctx.total_bytes:,} bytes across {len(ctx.files)} files[/dim]")
    if ctx.skipped:
        err.print(f"[dim]skipped {len(ctx.skipped)} files (use --verbose to see)[/dim]")


def _prompt_label(task: str) -> str:
    return f"{task} v={TASK_PROMPT_VERSIONS[task]}"


def _run_common(
    task: str,
    description: str,
    paths: tuple[str, ...],
    root: Path,
    model: str,
    max_tokens: int,
    effort: str | None,
    dry_run: bool,
    show_context: bool,
    verbose: bool,
    log_json: str | None,
) -> None:
    import time

    explicit = [Path(p) for p in paths] if paths else None
    gatherer = GATHERERS[task]
    ctx = gatherer(root=root, explicit_paths=explicit)

    if verbose and ctx.skipped:
        err.print("[dim]Skipped files:[/dim]")
        for rel, reason in ctx.skipped:
            err.print(f"  [dim]{rel}: {reason}[/dim]")

    if show_context:
        _render_context_summary(ctx)
        return

    user_msg = build_user_message(description, ctx.render())

    if dry_run:
        _render_context_summary(ctx)
        try:
            tokens = count_tokens(task, user_msg, model=model)
        except ClaudestructError as exc:
            err.print(f"[red]{exc}[/red]")
            sys.exit(1)
        err.print(f"[bold]Dry run:[/bold] would send ~{tokens:,} input tokens to {model}")
        err.print("[dim]system prompt will cache on first real run; subsequent runs cost ~10% of input[/dim]")
        return

    _render_context_summary(ctx)
    err.print(f"[bold]Running {task} on {model} (effort={effort or 'default'})[/bold]\n")

    def on_chunk(text: str) -> None:
        console.print(text, end="", markup=False, highlight=False)

    started = time.monotonic()
    with event_log.event_log(log_json) as sink:
        sink.write(event_log.run_start(
            task=task,
            model=model,
            effort=effort,
            prompt_version=TASK_PROMPT_VERSIONS.get(task),
        ))
        try:
            result = run_task(
                task,
                user_msg,
                model=model,
                max_tokens=max_tokens,
                effort=effort,
                stream_callback=on_chunk,
            )
        except ClaudestructError as exc:
            err.print(f"\n[red]{exc}[/red]")
            sink.write(event_log.run_end(
                reason="error",
                duration_ms=int((time.monotonic() - started) * 1000),
                total_cost_usd=0.0,
            ))
            sys.exit(1)
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
        sink.write(event_log.run_end(
            reason=result.stop_reason or "complete",
            duration_ms=int((time.monotonic() - started) * 1000),
            total_cost_usd=cost,
        ))
    console.print()
    _render_usage(result, task)


common_options = [
    click.option("--root", type=click.Path(exists=True, file_okay=False), default=None,
                 help="Project root (defaults to cwd)."),
    click.option("--model", default=DEFAULT_MODEL, show_default=True,
                 help="Claude model ID."),
    click.option("--max-tokens", type=int, default=DEFAULT_MAX_TOKENS, show_default=True,
                 help="Max output tokens."),
    click.option("--effort", type=click.Choice(["low", "medium", "high", "xhigh", "max"]),
                 default=None, help="Override per-task default effort."),
    click.option("--dry-run", is_flag=True,
                 help="Gather context + count tokens without calling Claude."),
    click.option("--show-context", is_flag=True,
                 help="Print the collected context summary and exit."),
    click.option("-v", "--verbose", is_flag=True, help="Verbose logging."),
    click.option("--log-json", type=click.Path(dir_okay=False), default=None,
                 help="Append structured JSON-lines events (run.start, agent.usage, "
                      "cache.warning, run.end) to this path. Stdout/Rich output unaffected."),
]


def _apply_options(func):
    for option in reversed(common_options):
        func = option(func)
    return func


@click.group(help="Token-efficient Claude Code companion.")
@click.version_option(__version__, prog_name="claudestruct")
def main() -> None:
    pass


@main.command("dev", help="Development task with smart context collection.")
@click.argument("description", required=True)
@click.argument("paths", nargs=-1, type=click.Path())
@_apply_options
def dev_cmd(description, paths, root, model, max_tokens, effort, dry_run, show_context, verbose, log_json):
    _run_common("dev", description, paths, _resolve_root(root), model, max_tokens,
                effort, dry_run, show_context, verbose, log_json)


@main.command("review", help="Code review on the current branch diff, or specified files.")
@click.argument("description", required=False, default="Review the code below for bugs, security issues, and maintainability concerns.")
@click.argument("paths", nargs=-1, type=click.Path())
@_apply_options
def review_cmd(description, paths, root, model, max_tokens, effort, dry_run, show_context, verbose, log_json):
    _run_common("review", description, paths, _resolve_root(root), model, max_tokens,
                effort, dry_run, show_context, verbose, log_json)


@main.command("plan", help="Architecture / planning mode.")
@click.argument("description", required=True)
@click.argument("paths", nargs=-1, type=click.Path())
@_apply_options
def plan_cmd(description, paths, root, model, max_tokens, effort, dry_run, show_context, verbose, log_json):
    _run_common("plan", description, paths, _resolve_root(root), model, max_tokens,
                effort, dry_run, show_context, verbose, log_json)


@main.command("debug", help="Debug an error, anchored on a failure description.")
@click.argument("description", required=True)
@click.argument("paths", nargs=-1, type=click.Path())
@_apply_options
def debug_cmd(description, paths, root, model, max_tokens, effort, dry_run, show_context, verbose, log_json):
    _run_common("debug", description, paths, _resolve_root(root), model, max_tokens,
                effort, dry_run, show_context, verbose, log_json)


@main.command("tokens", help="Count tokens for a given task + context without calling Claude.")
@click.argument("task", type=click.Choice(list(GATHERERS)))
@click.argument("description", required=True)
@click.argument("paths", nargs=-1, type=click.Path())
@click.option("--root", type=click.Path(exists=True, file_okay=False), default=None)
@click.option("--model", default=DEFAULT_MODEL, show_default=True)
def tokens_cmd(task, description, paths, root, model):
    explicit = [Path(p) for p in paths] if paths else None
    ctx = GATHERERS[task](root=_resolve_root(root), explicit_paths=explicit)
    user_msg = build_user_message(description, ctx.render())
    try:
        tokens = count_tokens(task, user_msg, model=model)
    except ClaudestructError as exc:
        err.print(f"[red]{exc}[/red]")
        sys.exit(1)
    console.print(f"{tokens}")


@main.command("context", help="Print the context that would be gathered for a task.")
@click.argument("task", type=click.Choice(list(GATHERERS)))
@click.argument("paths", nargs=-1, type=click.Path())
@click.option("--root", type=click.Path(exists=True, file_okay=False), default=None)
@click.option("--raw", is_flag=True, help="Print the raw rendered context instead of a summary.")
def context_cmd(task, paths, root, raw):
    explicit = [Path(p) for p in paths] if paths else None
    ctx = GATHERERS[task](root=_resolve_root(root), explicit_paths=explicit)
    if raw:
        console.print(ctx.render(), markup=False, highlight=False)
    else:
        _render_context_summary(ctx)


if __name__ == "__main__":
    main()
