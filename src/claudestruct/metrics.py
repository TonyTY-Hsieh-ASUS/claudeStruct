"""Prometheus text-format metrics export.

Aggregates the JSONL run logs under `<root>/.claudestruct/runs/` into a
single Prometheus text exposition. Designed to be served by a textfile
collector or scraped from a CI artifact — we don't run an HTTP server
ourselves, which would add lifecycle headaches that aren't worth it for
a one-shot CLI.

Format reference: https://prometheus.io/docs/instrumenting/exposition_formats/

Per Prometheus naming conventions:
  - `_total` suffix for monotonically-increasing counters.
  - Bare gauge names for "last observed value" semantics.
  - All token / cost labels share the `task` label so a single
    aggregation can answer "what does my dev usage cost vs review".
"""
from __future__ import annotations

from collections import defaultdict
from pathlib import Path
from typing import Iterable

from claudestruct.dashboard import RunSummary, load_summaries


def _escape_label(value: str) -> str:
    # Prometheus label values must escape `\`, `"`, and newlines.
    return value.replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n")


def _line(name: str, labels: dict[str, str], value: float | int) -> str:
    if labels:
        body = ",".join(
            f'{k}="{_escape_label(str(v))}"' for k, v in sorted(labels.items())
        )
        return f"{name}{{{body}}} {value}"
    return f"{name} {value}"


def render_prometheus(summaries: Iterable[RunSummary]) -> str:
    """Render all summaries as a Prometheus text exposition.

    Counters are sums across all runs; gauges (last_*) reflect the most
    recent run only. The intent is "show me lifetime spend + the latest
    run's shape" without forcing the consumer to pick a single mode.
    """
    rows = list(summaries)

    by_task_tokens: dict[tuple[str, str], int] = defaultdict(int)
    by_task_cost: dict[str, float] = defaultdict(float)
    by_task_runs: dict[str, int] = defaultdict(int)
    by_task_warnings: dict[str, int] = defaultdict(int)

    for s in rows:
        task = s.task or "unknown"
        by_task_runs[task] += 1
        by_task_tokens[(task, "input")] += s.input_tokens
        by_task_tokens[(task, "output")] += s.output_tokens
        by_task_tokens[(task, "cache_read")] += s.cache_read_tokens
        by_task_tokens[(task, "cache_creation")] += s.cache_creation_tokens
        by_task_cost[task] += s.cost_usd
        by_task_warnings[task] += len(s.cache_warnings)

    out: list[str] = []
    out.append("# HELP claudestruct_runs_total Total claudestruct CLI runs by task")
    out.append("# TYPE claudestruct_runs_total counter")
    for task, n in sorted(by_task_runs.items()):
        out.append(_line("claudestruct_runs_total", {"task": task}, n))

    out.append("")
    out.append("# HELP claudestruct_tokens_total Total tokens across runs by task and direction")
    out.append("# TYPE claudestruct_tokens_total counter")
    for (task, direction), n in sorted(by_task_tokens.items()):
        out.append(
            _line(
                "claudestruct_tokens_total",
                {"task": task, "direction": direction},
                n,
            )
        )

    out.append("")
    out.append("# HELP claudestruct_cost_usd_total Total estimated USD spend across runs by task")
    out.append("# TYPE claudestruct_cost_usd_total counter")
    for task, cost in sorted(by_task_cost.items()):
        out.append(
            _line("claudestruct_cost_usd_total", {"task": task}, round(cost, 6))
        )

    out.append("")
    out.append("# HELP claudestruct_cache_warnings_total Cumulative cache-miss warnings by task")
    out.append("# TYPE claudestruct_cache_warnings_total counter")
    for task, n in sorted(by_task_warnings.items()):
        out.append(
            _line("claudestruct_cache_warnings_total", {"task": task}, n)
        )

    if rows:
        last = rows[-1]
        out.append("")
        out.append("# HELP claudestruct_last_run_cost_usd Cost of the most recent run")
        out.append("# TYPE claudestruct_last_run_cost_usd gauge")
        out.append(
            _line(
                "claudestruct_last_run_cost_usd",
                {"task": last.task or "unknown"},
                round(last.cost_usd, 6),
            )
        )

        if last.duration_ms is not None:
            out.append("")
            out.append("# HELP claudestruct_last_run_duration_seconds Duration of the most recent run")
            out.append("# TYPE claudestruct_last_run_duration_seconds gauge")
            out.append(
                _line(
                    "claudestruct_last_run_duration_seconds",
                    {"task": last.task or "unknown"},
                    round(last.duration_ms / 1000, 3),
                )
            )

    return "\n".join(out) + "\n"


def write_prometheus_file(root: Path, out_path: Path) -> Path:
    """Aggregate the run history under `root/.claudestruct/runs/` and write
    the Prometheus exposition to `out_path`. Returns the path written."""
    summaries = load_summaries(root)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(render_prometheus(summaries), encoding="utf-8")
    return out_path
