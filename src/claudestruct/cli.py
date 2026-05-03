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
from collections.abc import Callable
from pathlib import Path

import click
from rich.console import Console
from rich.table import Table

from claudestruct import __version__, dashboard, metrics, sentry_init
from claudestruct import budget as budget_mod
from claudestruct import redact as redact_mod
from claudestruct.client import (
    DEFAULT_MAX_TOKENS,
    DEFAULT_MODEL,
    ClaudestructError,
    build_user_message,
    count_tokens,
)
from claudestruct.context import (
    BUDGETS_PER_TASK,
    gather_debug_context,
    gather_dev_context,
    gather_plan_context,
    gather_review_context,
)
from claudestruct.prompts import TASK_PROMPT_VERSIONS
from claudestruct.runner import run_task_and_log

# Best-effort: initialise error reporting at import time so any
# exception during Click parsing / option resolution is captured too.
# init() is a no-op when CLAUDESTRUCT_SENTRY_DSN is unset.
sentry_init.init()

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
    if getattr(result, "cached", False):
        # W10.4: replay badge so users see "this isn't a fresh roll".
        err.print(
            "[green](cached)[/green] response served from "
            "~/.claudestruct/llm_cache/ — no LLM call. "
            "Use --no-llm-cache to force-refresh.",
        )
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
    max_bytes: int | None,
    monthly_cap_usd: float | None,
    redact: bool,
    llm_cache: str | None,
    smart_context: bool = False,
) -> None:

    if monthly_cap_usd is not None and monthly_cap_usd > 0 and not dry_run:
        status = budget_mod.check_budget(root, monthly_cap_usd)
        if status.exceeded:
            err.print(
                f"[red]Monthly cap reached: ${status.spent_usd:.4f} spent of "
                f"${status.cap_usd:.2f} cap (UTC calendar month). Aborting before "
                f"any API call. Re-run with a higher --monthly-cap-usd, wait for "
                f"the next month, or unset the cap.[/red]"
            )
            sys.exit(2)
        if status.near_limit:
            err.print(
                f"[yellow]Cumulative spend: ${status.spent_usd:.4f} of "
                f"${status.cap_usd:.2f} cap "
                f"({status.spent_usd / status.cap_usd:.0%}); "
                f"${status.remaining_usd():.4f} remaining this month.[/yellow]"
            )

    explicit = [Path(p) for p in paths] if paths else None
    if smart_context and not explicit:
        from claudestruct.embed import EmbeddingError
        from claudestruct.indexer import smart_paths

        # Best-effort: a missing index or unreachable embed endpoint
        # warns + falls back to the gatherer's default (changed files /
        # diff walk). Mirrors the TS-side behaviour in claw-squad's
        # orchestrator integration — `--smart-context` should never
        # abort a run by itself, since the user can always re-issue
        # without the flag and get the same result.
        try:
            explicit = smart_paths(root, description, k=20)
        except EmbeddingError as exc:
            err.print(
                f"[yellow]--smart-context: embed endpoint unreachable "
                f"({exc}); falling back to keyword/diff walk[/yellow]\n"
                f"[dim]Set CLAUDESTRUCT_EMBED_BASE_URL / CLAUDESTRUCT_EMBED_MODEL "
                f"or omit the flag to silence this warning.[/dim]"
            )
            explicit = None  # gatherer falls back to its default candidate set
        if explicit is not None and not explicit:
            err.print(
                "[yellow]--smart-context: index returned no hits; "
                "falling back to keyword/diff walk. Run `cs index build` "
                "first to populate it.[/yellow]"
            )
            # Treat empty top-K as "no smart-context guidance" rather
            # than "the user explicitly named no files" — passing []
            # to the gatherer would also fall through to the default
            # candidate set, but None is the more honest signal.
            explicit = None
    gatherer = GATHERERS[task]
    budget = max_bytes if max_bytes is not None else BUDGETS_PER_TASK.get(task, 600_000)
    ctx = gatherer(root=root, explicit_paths=explicit, max_total_bytes=budget)

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

    try:
        outcome = run_task_and_log(
            task=task,
            description=description,
            paths=explicit,
            root=root,
            gatherer=gatherer,
            model=model,
            max_tokens=max_tokens,
            effort=effort,
            max_bytes=max_bytes,
            log_json=log_json,
            on_chunk=on_chunk,
            redactor=redact_mod.Redactor.default() if redact else None,
            llm_cache=llm_cache,
        )
    except ClaudestructError as exc:
        err.print(f"\n[red]{exc}[/red]")
        sys.exit(1)
    console.print()
    _render_usage(outcome.result, task)


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
    click.option("--max-bytes", type=int, default=None,
                 help="Override the per-task context budget. Defaults: review 200k, "
                      "dev 600k, debug 400k, plan 800k."),
    click.option("--monthly-cap-usd", type=float, default=None,
                 envvar="CLAUDESTRUCT_MONTHLY_CAP_USD",
                 help="Cumulative USD cap for the current calendar month (UTC). "
                      "Computed from <root>/.claudestruct/runs/*.jsonl. Hard-aborts "
                      "before the LLM call if exceeded; warns at 80% of cap. "
                      "Reads CLAUDESTRUCT_MONTHLY_CAP_USD by default."),
    click.option("--redact", is_flag=True,
                 envvar="CLAUDESTRUCT_REDACT",
                 help="Strip emails / API keys / JWTs from JSONL run logs before "
                      "they hit disk. Reads CLAUDESTRUCT_REDACT to default-on for "
                      "shared environments."),
    click.option("--llm-cache", "llm_cache", flag_value="on", default=None,
                 help="Force-enable the local LLM response cache "
                      "(~/.claudestruct/llm_cache/). On a cache hit, the LLM "
                      "call is skipped and the saved response replays — "
                      "useful for `cs review` regression-testing the same "
                      "diff repeatedly. Default policy: on for openai-compat, "
                      "off for anthropic (the SDK already caches there)."),
    click.option("--no-llm-cache", "llm_cache", flag_value="off",
                 help="Force-disable the local LLM response cache for this "
                      "run, even when CLAUDESTRUCT_LLM_CACHE is set."),
    click.option("--smart-context", is_flag=True,
                 help="Use the local embedding index to pick the top-K "
                      "files semantically related to the task description, "
                      "instead of the default glob/diff walk. Build the "
                      "index first via `cs index build`."),
]


def _apply_options(func):
    for option in reversed(common_options):
        func = option(func)
    return func


@click.group(help="Token-efficient Claude Code companion.")
@click.version_option(__version__, prog_name="claudestruct")
def main() -> None:
    pass


# `cs serve` is mounted from the optional [server] package. The import is
# lazy at module-load — it adds the subcommand to --help even when the
# extra isn't installed, but the actual call surfaces a clear error then.
try:
    from claudestruct.server.cli import attach_to as _attach_serve
    _attach_serve(main)
except ImportError:
    @main.group("serve", help="Daemon-mode HTTP API (requires [server] extra).")
    def _serve_placeholder() -> None:
        raise click.ClickException(
            "Install the server extra first:\n  pip install 'claudestruct[server]'"
        )


@main.command("dev", help="Development task with smart context collection.")
@click.argument("description", required=True)
@click.argument("paths", nargs=-1, type=click.Path())
@_apply_options
def dev_cmd(description, paths, root, model, max_tokens, effort, dry_run, show_context, verbose, log_json, max_bytes, monthly_cap_usd, redact, llm_cache, smart_context):
    _run_common("dev", description, paths, _resolve_root(root), model, max_tokens,
                effort, dry_run, show_context, verbose, log_json, max_bytes, monthly_cap_usd, redact, llm_cache,
                smart_context=smart_context)


@main.command("review", help="Code review on the current branch diff, or specified files.")
@click.argument("description", required=False, default="Review the code below for bugs, security issues, and maintainability concerns.")
@click.argument("paths", nargs=-1, type=click.Path())
@_apply_options
def review_cmd(description, paths, root, model, max_tokens, effort, dry_run, show_context, verbose, log_json, max_bytes, monthly_cap_usd, redact, llm_cache, smart_context):
    _run_common("review", description, paths, _resolve_root(root), model, max_tokens,
                effort, dry_run, show_context, verbose, log_json, max_bytes, monthly_cap_usd, redact, llm_cache,
                smart_context=smart_context)


@main.command("plan", help="Architecture / planning mode.")
@click.argument("description", required=True)
@click.argument("paths", nargs=-1, type=click.Path())
@_apply_options
def plan_cmd(description, paths, root, model, max_tokens, effort, dry_run, show_context, verbose, log_json, max_bytes, monthly_cap_usd, redact, llm_cache, smart_context):
    _run_common("plan", description, paths, _resolve_root(root), model, max_tokens,
                effort, dry_run, show_context, verbose, log_json, max_bytes, monthly_cap_usd, redact, llm_cache,
                smart_context=smart_context)


@main.command("debug", help="Debug an error, anchored on a failure description.")
@click.argument("description", required=True)
@click.argument("paths", nargs=-1, type=click.Path())
@_apply_options
def debug_cmd(description, paths, root, model, max_tokens, effort, dry_run, show_context, verbose, log_json, max_bytes, monthly_cap_usd, redact, llm_cache, smart_context):
    _run_common("debug", description, paths, _resolve_root(root), model, max_tokens,
                effort, dry_run, show_context, verbose, log_json, max_bytes, monthly_cap_usd, redact, llm_cache,
                smart_context=smart_context)


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


@main.group("index", help="Manage the local embedding index for --smart-context (W10.5).")
def index_group() -> None:
    pass


@index_group.command("build", help="Walk the repo and (re-)embed every source file into the local index.")
@click.option("--root", type=click.Path(exists=True, file_okay=False), default=None)
def index_build_cmd(root: str | None) -> None:
    from claudestruct.embed import EmbeddingError
    from claudestruct.indexer import build_index

    resolved = _resolve_root(root)

    def _progress(msg: str) -> None:
        err.print(f"[dim]{msg}[/dim]")

    try:
        stats = build_index(resolved, progress=_progress)
    except EmbeddingError as exc:
        err.print(f"[red]embedding endpoint failed:[/red] {exc}")
        sys.exit(2)
    console.print(
        f"walked {stats.walked} file(s); "
        f"embedded {stats.embedded}; "
        f"skipped {stats.skipped_unchanged} unchanged, "
        f"{stats.skipped_unreadable} unreadable"
    )


@index_group.command("stats", help="Print row count + embedding dimension for the local index.")
@click.option("--root", type=click.Path(exists=True, file_okay=False), default=None)
def index_stats_cmd(root: str | None) -> None:
    from claudestruct.index import Index

    resolved = _resolve_root(root)
    with Index.open(resolved) as idx:
        s = idx.stats()
    console.print(f"entries: {s.entries}\ndimension: {s.dimension}")


@index_group.command("clear", help="Drop every row from the local index.")
@click.option("--root", type=click.Path(exists=True, file_okay=False), default=None)
def index_clear_cmd(root: str | None) -> None:
    from claudestruct.index import Index

    resolved = _resolve_root(root)
    with Index.open(resolved) as idx:
        n = idx.clear()
    console.print(f"deleted {n} entr{'y' if n == 1 else 'ies'}")


@main.group("dataset", help="Mine the run-log directory for fine-tuning datasets (W10.6).")
def dataset_group() -> None:
    pass


@main.group("voice", help="Voice capture + local Whisper transcription (W10.7).")
def voice_group() -> None:
    pass


def _voice_common_options(func):
    func = click.option("--model", "voice_model", default="base.en", show_default=True,
                        help="Whisper model name. Larger = slower + more accurate.")(func)
    func = click.option("--language", "voice_language", default=None,
                        help="ISO 639-1 / Whisper language code (e.g. 'zh'). "
                             "Default: auto-detect.")(func)
    func = click.option("--seconds", "voice_seconds", type=float, default=5.0, show_default=True,
                        help="How long to record from the default mic.")(func)
    func = click.option("--device", "voice_device", default=None,
                        help="Whisper compute device override (cpu / cuda / auto). "
                             "Default lets faster-whisper pick.")(func)
    return func


def _build_voice_config(*, voice_model, voice_language, voice_seconds, voice_device):
    from claudestruct.voice import VoiceConfig

    return VoiceConfig(
        model=voice_model,
        language=voice_language,
        seconds=voice_seconds,
        device=voice_device,
    )


@voice_group.command("transcribe", help="Record from the default mic and print the transcription.")
@_voice_common_options
def voice_transcribe_cmd(voice_model, voice_language, voice_seconds, voice_device):
    from claudestruct.voice import VoiceError, capture_and_transcribe

    cfg = _build_voice_config(
        voice_model=voice_model, voice_language=voice_language,
        voice_seconds=voice_seconds, voice_device=voice_device,
    )
    err.print(f"[dim]listening for {cfg.seconds:.1f}s…[/dim]")
    try:
        text = capture_and_transcribe(cfg)
    except VoiceError as exc:
        err.print(f"[red]{exc}[/red]")
        sys.exit(2)
    if not text:
        err.print("[yellow]no speech detected[/yellow]")
        sys.exit(1)
    # Plain stdout (no Rich formatting) so callers can pipe:
    #   cs dev "$(cs voice transcribe)"
    click.echo(text)


@voice_group.command("run", help="Record + transcribe + invoke a cs task with the result.")
@click.argument("task", type=click.Choice(["dev", "review", "plan", "debug"]))
@_voice_common_options
@click.option("--print-only", is_flag=True,
              help="Print the transcription instead of running the task. Useful "
                   "for sanity-checking the mic before committing to an LLM call.")
def voice_run_cmd(task: str, voice_model, voice_language, voice_seconds, voice_device,
                  print_only: bool):
    from claudestruct.voice import VoiceError, capture_and_transcribe

    cfg = _build_voice_config(
        voice_model=voice_model, voice_language=voice_language,
        voice_seconds=voice_seconds, voice_device=voice_device,
    )
    err.print(f"[dim]listening for {cfg.seconds:.1f}s…[/dim]")
    try:
        text = capture_and_transcribe(cfg)
    except VoiceError as exc:
        err.print(f"[red]{exc}[/red]")
        sys.exit(2)
    if not text:
        err.print("[yellow]no speech detected; not invoking cs " + task + "[/yellow]")
        sys.exit(1)
    err.print(f"[bold]heard:[/bold] {text}")
    if print_only:
        click.echo(text)
        return
    # Dispatch the captured task. We call _run_common directly rather
    # than invoking another Click command so we share the exact same
    # argument resolution + budget code path the user would get from
    # `cs <task> "<text>"` typed by hand.
    _run_common(
        task, text, (), _resolve_root(None),
        DEFAULT_MODEL, DEFAULT_MAX_TOKENS, None,
        False, False, False, None, None, None, False, None,
        smart_context=False,
    )


@dataset_group.command("export", help="Walk .claudestruct/runs/*.jsonl and write a training-format JSONL.")
@click.option("--out", "out_path", type=click.Path(dir_okay=False), required=True,
              help="Output JSONL path. Created (or overwritten) by this command.")
@click.option("--root", type=click.Path(exists=True, file_okay=False), default=None,
              help="Repo root whose .claudestruct/runs/ feeds the export. Defaults to cwd.")
@click.option("--task", type=click.Choice(["dev", "review", "plan", "debug"]), default=None,
              help="Filter by task. Default: include all four.")
@click.option("--since", "since_str", type=str, default=None,
              help="Filter to events on or after this date (YYYY-MM-DD or ISO 8601).")
@click.option("--format", "fmt", type=click.Choice(["alpaca", "chat"]), default="alpaca",
              show_default=True,
              help="Output schema. alpaca = {instruction,input,output}; chat = {messages: [...]}.")
def dataset_export_cmd(out_path: str, root: str | None, task: str | None,
                       since_str: str | None, fmt: str) -> None:
    from claudestruct.dataset import export_dataset, parse_since

    since = None
    if since_str:
        try:
            since = parse_since(since_str)
        except ValueError as exc:
            err.print(f"[red]{exc}[/red]")
            sys.exit(2)

    stats = export_dataset(
        _resolve_root(root),
        Path(out_path),
        fmt=fmt,
        task=task,
        since=since,
    )
    if stats.rows == 0:
        err.print(
            "[yellow]wrote 0 rows. CLAUDESTRUCT_LOG_PROMPTS=1 must be set "
            "*before* a run for that run's IO to be exported.[/yellow]"
        )
    note = ""
    if stats.skipped_no_io:
        note = f" ({stats.skipped_no_io} event(s) skipped: missing IO fields)"
    console.print(f"wrote {stats.rows} row(s) to {stats.output_path}{note}")


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


def _render_dashboard_table(summaries, limit: int, show_tool: bool = False) -> None:
    if not summaries:
        err.print("[dim]no runs logged yet[/dim]")
        return
    title = "claudestruct + claw-squad runs" if show_tool else "claudestruct runs"
    table = Table(title=title, show_header=True, header_style="bold")
    table.add_column("started", style="cyan", no_wrap=True)
    if show_tool:
        table.add_column("tool", style="magenta", no_wrap=True)
    table.add_column("task")
    table.add_column("model", overflow="fold")
    table.add_column("cost", justify="right")
    table.add_column("in", justify="right")
    table.add_column("out", justify="right")
    table.add_column("cacheR", justify="right")
    table.add_column("dur", justify="right")
    table.add_column("reason")
    for s in summaries[-limit:]:
        when = (s.started_at or "")[:19].replace("T", " ")
        dur = f"{s.duration_ms/1000:.1f}s" if s.duration_ms else "—"
        row = [
            when,
            *([s.tool] if show_tool else []),
            s.task or "—",
            s.model or "—",
            f"${s.cost_usd:.4f}",
            f"{s.input_tokens:,}",
            f"{s.output_tokens:,}",
            f"{s.cache_read_tokens:,}",
            dur,
            s.reason or "—",
        ]
        table.add_row(*row)
    err.print(table)
    if any(s.cache_warnings for s in summaries):
        warned = sum(len(s.cache_warnings) for s in summaries)
        err.print(f"[yellow]{warned} cache warnings across runs (use --json to inspect)[/yellow]")


@main.command("dashboard", help="Print a cost / outcome table for every run logged under .claudestruct/runs/.")
@click.option("--root", type=click.Path(exists=True, file_okay=False), default=None,
              help="Project root (defaults to cwd).")
@click.option("--task", type=click.Choice(list(GATHERERS)), default=None,
              help="Filter to a single task type.")
@click.option("--json", "as_json", is_flag=True,
              help="Emit machine-readable JSON instead of the human table.")
@click.option("--limit", type=int, default=20, show_default=True,
              help="Show only the most recent N runs (table view).")
@click.option("--watch", "watch_seconds", type=float, default=None,
              help="Re-render every N seconds. Ctrl-C to exit. Mirrors `claw-squad dashboard --watch`.")
@click.option("--include-claw-squad", is_flag=True,
              help="Also fold .claw-squad/runs/*.jsonl into the table (single pane for "
                   "teams running both tools). Adds a `tool` column.")
def dashboard_cmd(root, task, as_json, limit, watch_seconds, include_claw_squad):
    import time
    resolved_root = _resolve_root(root)

    def render_once():
        if include_claw_squad:
            summaries = dashboard.load_summaries_with_claw_squad(resolved_root)
        else:
            summaries = dashboard.load_summaries(resolved_root)
        if task:
            summaries = dashboard.filter_summaries(summaries, task=task)
        if as_json:
            console.print(dashboard.to_json(summaries), markup=False, highlight=False)
        else:
            _render_dashboard_table(summaries, limit, show_tool=include_claw_squad)

    if watch_seconds is None:
        render_once()
        return

    if watch_seconds < 0.2:
        err.print("[red]--watch interval must be ≥ 0.2 seconds[/red]")
        sys.exit(1)
    try:
        while True:
            # ANSI clear + cursor home; matches claw-squad's behavior so
            # the two tools feel uniform when watched side-by-side.
            console.print("\x1bc", end="")
            render_once()
            err.print(f"[dim]watching {resolved_root}/  •  Ctrl-C to exit[/dim]")
            time.sleep(watch_seconds)
    except KeyboardInterrupt:
        sys.exit(0)


@main.command("metrics", help="Emit Prometheus text-format metrics aggregated from .claudestruct/runs/.")
@click.option("--root", type=click.Path(exists=True, file_okay=False), default=None,
              help="Project root (defaults to cwd).")
@click.option("--out", "out_path", type=click.Path(dir_okay=False), default=None,
              help="Write to this file instead of stdout. Useful for node_exporter's textfile collector.")
def metrics_cmd(root, out_path):
    summaries = dashboard.load_summaries(_resolve_root(root))
    text = metrics.render_prometheus(summaries)
    if out_path:
        Path(out_path).parent.mkdir(parents=True, exist_ok=True)
        Path(out_path).write_text(text, encoding="utf-8")
        err.print(f"[dim]wrote {len(text)} bytes to {out_path}[/dim]")
    else:
        console.print(text, markup=False, highlight=False, end="")


@main.command("mcp", help="Start the claudestruct MCP server over stdio. Wire into Claude Code via .mcp config.")
def mcp_cmd():
    # Lazy import — the `mcp` SDK is heavy and unrelated to dev/review/plan/debug.
    from claudestruct.mcp_server import run as run_mcp
    try:
        run_mcp()
    except ClaudestructError as exc:
        err.print(f"[red]{exc}[/red]")
        sys.exit(1)


@main.group("logs", help="Inspect / manage the per-run JSONL logs.")
def logs_group():
    pass


@logs_group.command("purge", help="Delete run-log files older than --older-than-days.")
@click.option("--root", type=click.Path(exists=True, file_okay=False), default=None,
              help="Project root (defaults to cwd).")
@click.option("--older-than-days", type=int, required=True,
              help="Delete files whose mtime is older than this many days.")
@click.option("--dry-run", is_flag=True,
              help="List the files that would be deleted; don't touch them.")
def logs_purge_cmd(root, older_than_days, dry_run):
    from datetime import timedelta

    target = _resolve_root(root)
    victims = redact_mod.purge_runs(
        target,
        older_than=timedelta(days=older_than_days),
        dry_run=dry_run,
    )
    if not victims:
        err.print("[dim]No run logs older than the cutoff.[/dim]")
        return
    verb = "Would delete" if dry_run else "Deleted"
    err.print(f"[bold]{verb} {len(victims)} file(s):[/bold]")
    for p in victims:
        err.print(f"  {p}")


if __name__ == "__main__":
    main()
