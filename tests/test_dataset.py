"""Tests for `claudestruct.dataset` (W10.6 — fine-tuning export)."""
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

import pytest

from claudestruct import dataset


def _write_jsonl(path: Path, events: list[dict]) -> None:
    """Tiny helper: each test writes a fake `.claudestruct/runs/*.jsonl`
    file. We don't use the real runner here — it'd pull in the SDK
    plus the whole CLI. The dataset module reads JSONL and that's the
    contract we're locking in."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as fh:
        for e in events:
            fh.write(json.dumps(e) + "\n")


def _io_event(*, task: str = "review", description: str = "look at the diff",
              response: str = "lgtm modulo a typo on line 7", ts: str = "2026-05-01T10:00:00Z",
              model: str = "claude-opus-4-7") -> dict:
    return {
        "ts": ts,
        "type": "run.io",
        "task": task,
        "model": model,
        "description": description,
        "responseText": response,
        "responseTruncated": False,
    }


# --- walk_run_io ----------------------------------------------------


def test_walk_run_io_yields_only_run_io_events(tmp_path: Path):
    """run.start / agent.usage / cache.warning rows live in the same
    file; the walker must skip them so a downstream consumer doesn't
    have to filter."""
    log = tmp_path / ".claudestruct" / "runs" / "abc.jsonl"
    _write_jsonl(log, [
        {"type": "run.start", "task": "review", "ts": "2026-05-01T10:00:00Z"},
        _io_event(),
        {"type": "agent.usage", "ts": "2026-05-01T10:00:01Z"},
        {"type": "run.end", "ts": "2026-05-01T10:00:02Z"},
    ])
    events = list(dataset.walk_run_io(tmp_path))
    assert len(events) == 1
    assert events[0]["type"] == "run.io"


def test_walk_run_io_filters_by_task(tmp_path: Path):
    log = tmp_path / ".claudestruct" / "runs" / "x.jsonl"
    _write_jsonl(log, [
        _io_event(task="review", description="r"),
        _io_event(task="dev", description="d"),
        _io_event(task="debug", description="b"),
    ])
    out = list(dataset.walk_run_io(tmp_path, task="dev"))
    assert [e["description"] for e in out] == ["d"]


def test_walk_run_io_filters_by_since(tmp_path: Path):
    log = tmp_path / ".claudestruct" / "runs" / "x.jsonl"
    _write_jsonl(log, [
        _io_event(ts="2025-12-31T23:59:59Z", description="old"),
        _io_event(ts="2026-05-01T10:00:00Z", description="new"),
    ])
    cutoff = datetime(2026, 1, 1, tzinfo=timezone.utc)
    out = list(dataset.walk_run_io(tmp_path, since=cutoff))
    assert [e["description"] for e in out] == ["new"]


def test_walk_run_io_keeps_events_with_unparseable_ts(tmp_path: Path):
    """Better to over-include than silently drop. Locking the policy."""
    log = tmp_path / ".claudestruct" / "runs" / "x.jsonl"
    _write_jsonl(log, [_io_event(ts="not a real timestamp")])
    cutoff = datetime(2026, 1, 1, tzinfo=timezone.utc)
    out = list(dataset.walk_run_io(tmp_path, since=cutoff))
    assert len(out) == 1


def test_walk_run_io_handles_corrupt_lines(tmp_path: Path):
    """A hand-edited log with one bad row shouldn't kill the export."""
    log = tmp_path / ".claudestruct" / "runs" / "x.jsonl"
    log.parent.mkdir(parents=True, exist_ok=True)
    log.write_text(
        json.dumps(_io_event(description="ok")) + "\n"
        + "{not-json,broken}\n"
        + json.dumps(_io_event(description="also ok")) + "\n",
        encoding="utf-8",
    )
    out = list(dataset.walk_run_io(tmp_path))
    assert [e["description"] for e in out] == ["ok", "also ok"]


def test_walk_run_io_returns_empty_when_runs_dir_missing(tmp_path: Path):
    """No runs dir = no data; not an error."""
    assert list(dataset.walk_run_io(tmp_path)) == []


def test_walk_run_io_walks_multiple_files_in_sorted_order(tmp_path: Path):
    """Determinism matters when the dataset ends up in a training run —
    you want the same input order every export so checkpoint diffs
    are interpretable."""
    base = tmp_path / ".claudestruct" / "runs"
    _write_jsonl(base / "a.jsonl", [_io_event(description="from-a")])
    _write_jsonl(base / "b.jsonl", [_io_event(description="from-b")])
    out = list(dataset.walk_run_io(tmp_path))
    assert [e["description"] for e in out] == ["from-a", "from-b"]


# --- to_alpaca / to_chat -------------------------------------------


def test_to_alpaca_picks_task_specific_instruction():
    pair = dataset.to_alpaca(_io_event(task="review", description="d", response="r"))
    assert pair is not None
    assert "reviewer" in pair["instruction"].lower()
    assert pair["input"] == "d"
    assert pair["output"] == "r"


def test_to_alpaca_returns_none_when_response_blank():
    """Blank responses come from a stop-sequence early-exit; they're
    poison for fine-tuning so we skip rather than emit empty rows."""
    assert dataset.to_alpaca(_io_event(response="")) is None
    assert dataset.to_alpaca(_io_event(response="   \n")) is None


def test_to_alpaca_returns_none_when_description_missing():
    bad = {"type": "run.io", "task": "review", "responseText": "r"}
    assert dataset.to_alpaca(bad) is None


def test_to_chat_emits_three_role_messages():
    pair = dataset.to_chat(_io_event(task="dev", description="add a feature", response="patch"))
    assert pair is not None
    roles = [m["role"] for m in pair["messages"]]
    assert roles == ["system", "user", "assistant"]
    assert pair["messages"][1]["content"] == "add a feature"
    assert pair["messages"][2]["content"] == "patch"


# --- export_dataset --------------------------------------------------


def test_export_dataset_round_trip(tmp_path: Path):
    log = tmp_path / ".claudestruct" / "runs" / "r.jsonl"
    _write_jsonl(log, [
        _io_event(task="review", description="d1", response="o1"),
        _io_event(task="review", description="d2", response="o2"),
    ])
    out = tmp_path / "out.jsonl"
    stats = dataset.export_dataset(tmp_path, out)
    assert stats.rows == 2
    assert stats.output_path == out
    lines = out.read_text(encoding="utf-8").splitlines()
    assert len(lines) == 2
    first = json.loads(lines[0])
    assert first["input"] == "d1"
    assert first["output"] == "o1"


def test_export_dataset_chat_format(tmp_path: Path):
    log = tmp_path / ".claudestruct" / "runs" / "r.jsonl"
    _write_jsonl(log, [_io_event(description="d", response="o")])
    out = tmp_path / "out.jsonl"
    dataset.export_dataset(tmp_path, out, fmt="chat")
    row = json.loads(out.read_text(encoding="utf-8").splitlines()[0])
    assert "messages" in row
    assert len(row["messages"]) == 3


def test_export_dataset_creates_empty_file_when_no_matches(tmp_path: Path):
    """Empty result is not an error — we want a well-formed (empty)
    file so downstream pipelines (`wc -l output.jsonl`) don't have to
    special-case missing files."""
    out = tmp_path / "out.jsonl"
    stats = dataset.export_dataset(tmp_path, out)
    assert stats.rows == 0
    assert out.exists()
    assert out.read_text(encoding="utf-8") == ""


def test_export_dataset_counts_skipped_no_io(tmp_path: Path):
    """Events that ARE run.io but lack the description / response
    fields show up in skipped_no_io so an operator can debug a
    surprising row count."""
    log = tmp_path / ".claudestruct" / "runs" / "r.jsonl"
    _write_jsonl(log, [
        _io_event(description="d", response="o"),  # good
        {"type": "run.io", "task": "review", "ts": "2026-05-01T10:00:00Z"},  # missing fields
    ])
    out = tmp_path / "out.jsonl"
    stats = dataset.export_dataset(tmp_path, out)
    assert stats.rows == 1
    assert stats.skipped_no_io == 1


def test_export_dataset_rejects_unknown_format(tmp_path: Path):
    with pytest.raises(ValueError, match="unknown dataset format"):
        dataset.export_dataset(tmp_path, tmp_path / "x.jsonl", fmt="bogus")


def test_export_dataset_creates_parent_dir(tmp_path: Path):
    """`--out path/that/does/not/exist/yet/data.jsonl` should work
    without making the operator mkdir first."""
    out = tmp_path / "subdir" / "deeper" / "out.jsonl"
    dataset.export_dataset(tmp_path, out)
    assert out.exists()


# --- parse_since ----------------------------------------------------


def test_parse_since_accepts_date_only():
    got = dataset.parse_since("2026-01-15")
    assert got.year == 2026 and got.month == 1 and got.day == 15
    assert got.tzinfo is not None


def test_parse_since_accepts_iso_with_offset():
    got = dataset.parse_since("2026-01-15T10:00:00+00:00")
    assert got.year == 2026 and got.hour == 10


def test_parse_since_accepts_iso_with_z_suffix():
    got = dataset.parse_since("2026-01-15T10:00:00Z")
    assert got.year == 2026


def test_parse_since_rejects_garbage():
    with pytest.raises(ValueError):
        dataset.parse_since("not a date")


# --- run_io event constructor + opt-in gate -----------------------


def test_run_io_event_has_expected_shape():
    """Lock the schema so a downstream consumer (cs dataset export,
    third-party tools) can rely on the field names."""
    from claudestruct import logging as event_log

    e = event_log.run_io(
        task="review",
        model="claude-opus-4-7",
        description="d",
        response_text="o",
    )
    assert e["type"] == "run.io"
    assert e["task"] == "review"
    assert e["description"] == "d"
    assert e["responseText"] == "o"
    assert e["responseTruncated"] is False


def test_run_io_event_truncates_huge_responses():
    """100 KB cap protects log files from runaway models."""
    from claudestruct import logging as event_log

    huge = "x" * (200 * 1024)
    e = event_log.run_io(task="dev", model="m", description="d", response_text=huge)
    assert len(e["responseText"]) == 100 * 1024
    assert e["responseTruncated"] is True


def test_log_prompts_gate_default_off(monkeypatch):
    from claudestruct import runner

    monkeypatch.delenv("CLAUDESTRUCT_LOG_PROMPTS", raising=False)
    assert runner._log_prompts_enabled() is False


@pytest.mark.parametrize("v", ["1", "true", "TRUE", "yes", "on"])
def test_log_prompts_gate_truthy(monkeypatch, v: str):
    from claudestruct import runner

    monkeypatch.setenv("CLAUDESTRUCT_LOG_PROMPTS", v)
    assert runner._log_prompts_enabled() is True


@pytest.mark.parametrize("v", ["0", "false", "no", "off", ""])
def test_log_prompts_gate_falsy(monkeypatch, v: str):
    from claudestruct import runner

    monkeypatch.setenv("CLAUDESTRUCT_LOG_PROMPTS", v)
    assert runner._log_prompts_enabled() is False
