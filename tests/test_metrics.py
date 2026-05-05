"""Prometheus exposition format tests.

The output format is what consumers parse, so the cases pin: the
format is well-formed (`# HELP` / `# TYPE` headers before metrics),
labels escape correctly, and the math (counter sums, last-run gauges)
matches what's in the JSONL stream.
"""
from __future__ import annotations

import json

from claudestruct import dashboard, metrics


def _write_run(path, events):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as fh:
        for ev in events:
            fh.write(json.dumps(ev) + "\n")


def _make_run(tmp_path, name, *, task, cost, in_tok, out_tok, cache_read=0, warnings=0):
    events = [
        {"type": "run.start", "ts": "2026-04-25T00:00:00Z", "task": task,
         "model": "claude-opus-4-7"},
        {"type": "agent.usage", "ts": "2026-04-25T00:00:01Z", "role": "claudestruct",
         "provider": "anthropic", "model": "claude-opus-4-7",
         "inputTokens": in_tok, "outputTokens": out_tok,
         "cacheReadTokens": cache_read, "cacheCreationTokens": 0,
         "costUsd": cost},
    ]
    for _ in range(warnings):
        events.append({"type": "cache.warning", "ts": "2026-04-25T00:00:02Z",
                       "message": "miss"})
    events.append({"type": "run.end", "ts": "2026-04-25T00:00:03Z",
                   "reason": "end_turn", "durationMs": 1000, "totalCostUsd": cost})
    _write_run(dashboard.runs_dir(tmp_path) / f"{name}.jsonl", events)


def test_empty_history_renders_only_headers(tmp_path):
    text = metrics.render_prometheus(dashboard.load_summaries(tmp_path))
    # No data lines, but the HELP/TYPE preamble still emits.
    assert "claudestruct_runs_total" in text
    assert "# HELP" in text
    assert "# TYPE" in text


def test_counter_sums_across_runs(tmp_path):
    _make_run(tmp_path, "a", task="dev", cost=0.1, in_tok=100, out_tok=50)
    _make_run(tmp_path, "b", task="dev", cost=0.2, in_tok=200, out_tok=70)
    _make_run(tmp_path, "c", task="review", cost=0.05, in_tok=50, out_tok=20)
    text = metrics.render_prometheus(dashboard.load_summaries(tmp_path))
    assert 'claudestruct_runs_total{task="dev"} 2' in text
    assert 'claudestruct_runs_total{task="review"} 1' in text
    assert 'claudestruct_tokens_total{direction="input",task="dev"} 300' in text
    assert 'claudestruct_tokens_total{direction="output",task="dev"} 120' in text
    # Cost is summed and rounded to 6 dp.
    assert 'claudestruct_cost_usd_total{task="dev"} 0.3' in text


def test_last_run_gauge_matches_most_recent(tmp_path):
    _make_run(tmp_path, "2026-04-25T00-00-00Z", task="dev", cost=0.1, in_tok=100, out_tok=50)
    _make_run(tmp_path, "2026-04-25T01-00-00Z", task="review", cost=0.05, in_tok=50, out_tok=20)
    text = metrics.render_prometheus(dashboard.load_summaries(tmp_path))
    # Sorted last by filename → second one is most recent.
    assert 'claudestruct_last_run_cost_usd{task="review"} 0.05' in text
    assert 'claudestruct_last_run_duration_seconds{task="review"} 1' in text


def test_warnings_counter_includes_cache_misses(tmp_path):
    _make_run(tmp_path, "a", task="dev", cost=0.1, in_tok=100, out_tok=50, warnings=2)
    _make_run(tmp_path, "b", task="dev", cost=0.1, in_tok=100, out_tok=50, warnings=1)
    text = metrics.render_prometheus(dashboard.load_summaries(tmp_path))
    assert 'claudestruct_cache_warnings_total{task="dev"} 3' in text


def test_label_escaping(tmp_path):
    """A task name with a quote / backslash shouldn't break the parser."""
    _make_run(tmp_path, "a", task='dev"x\\y', cost=0.0, in_tok=0, out_tok=0)
    text = metrics.render_prometheus(dashboard.load_summaries(tmp_path))
    # Both quote and backslash must be escaped per Prometheus spec.
    assert r'task="dev\"x\\y"' in text


def test_format_lines_match_prometheus_grammar(tmp_path):
    """Each non-comment / non-empty line must match `<name>{<labels>} <value>`."""
    _make_run(tmp_path, "a", task="dev", cost=0.1, in_tok=100, out_tok=50)
    text = metrics.render_prometheus(dashboard.load_summaries(tmp_path))
    import re
    pattern = re.compile(
        r'^[a-zA-Z_:][a-zA-Z0-9_:]*(?:\{[^}]*\})?\s+[-+0-9eE.]+$'
    )
    for line in text.splitlines():
        if not line or line.startswith("#"):
            continue
        assert pattern.match(line), f"bad line: {line!r}"
