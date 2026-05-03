"""Tests for the `--smart-context` CLI fallback path (W10.5b polish).

When the embedding endpoint is unreachable or the index is empty,
`cs <task> --smart-context` should warn + fall back to the
gatherer's default candidate set — never abort the run. This
mirrors the TS-side behaviour in `claw-squad run --smart-context`
and was the explicit polish gap in the Python surface.
"""
from __future__ import annotations

import pytest
from click.testing import CliRunner

from claudestruct import cli as cli_mod
from claudestruct.embed import EmbeddingError


@pytest.fixture(autouse=True)
def _no_real_api_calls(monkeypatch):
    """Stub count_tokens so --dry-run doesn't try to reach Anthropic.
    Every test in this file uses --dry-run to exit before the real
    LLM call, but count_tokens itself dispatches to the provider's
    tokenizer endpoint (which still needs an API key on the
    Anthropic path). Returning a fixed value short-circuits that."""
    monkeypatch.setattr(
        "claudestruct.cli.count_tokens",
        lambda task, user_msg, model: 100,
    )
    # Also set a dummy key so any other code path that reads it
    # (e.g. the secret loader during config init) doesn't bail.
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-test-stub")


def _runner() -> CliRunner:
    # Click 8.3 dropped `mix_stderr`; stderr is captured separately
    # by default and _stderr(result) returns the stderr-only stream.
    return CliRunner()


def _stderr(result) -> str:
    """Return the captured stderr regardless of Click version.
    Click 8.3 exposes `result.stderr` only when stderr capture is
    enabled; older versions raised when stderr was merged with
    stdout. Fall back to `result.output` so the test reads either."""
    try:
        return result.stderr
    except (AttributeError, ValueError):
        return result.output


def test_smart_context_embed_error_falls_back_to_default_gather(
    monkeypatch, tmp_path,
):
    """EmbeddingError used to exit 2. After the polish it warns +
    falls back to the same path the run would have taken without
    --smart-context. We assert via --dry-run so no real LLM call
    happens; that's enough to exercise the fallback branch."""

    def fake_smart_paths(*args, **kwargs):
        raise EmbeddingError("connection refused")

    # Replace the lazy import target. `_run_common` does
    # `from claudestruct.indexer import smart_paths`, so patch the
    # source attribute, not a stale local rebind.
    monkeypatch.setattr("claudestruct.indexer.smart_paths", fake_smart_paths)

    # Avoid hitting Anthropic: --dry-run short-circuits before the
    # API call. The fallback path still runs through the gatherer
    # so we exercise the non-error code path end-to-end.
    result = _runner().invoke(
        cli_mod.main,
        ["dev", "--root", str(tmp_path), "--dry-run", "do something"],
    )
    # Exit 0 = the fallback succeeded (the OLD behaviour was sys.exit(2)).
    assert result.exit_code == 0, (
        f"smart-context with --smart-context not set should not exit; "
        f"got {result.exit_code}; stderr={_stderr(result)}"
    )


def test_smart_context_embed_error_warns_when_flag_set(
    monkeypatch, tmp_path,
):
    """When the flag IS set + the embed endpoint fails, the warning
    must mention the fallback so the operator knows the run isn't
    using semantic ranking."""

    def fake_smart_paths(*args, **kwargs):
        raise EmbeddingError("ollama not running")

    monkeypatch.setattr("claudestruct.indexer.smart_paths", fake_smart_paths)

    result = _runner().invoke(
        cli_mod.main,
        [
            "dev",
            "--root", str(tmp_path),
            "--smart-context",
            "--dry-run",
            "describe the change",
        ],
    )
    assert result.exit_code == 0, _stderr(result)
    # The warning message must mention "falling back" — that's the
    # contract operators rely on for understanding what context
    # source actually fed the prompt.
    assert "falling back" in _stderr(result).lower()


def test_smart_context_empty_index_warns_and_falls_back(
    monkeypatch, tmp_path,
):
    """An index that's been built but has no hits for the description
    used to fall through silently with `explicit=[]` (which the
    gatherer treated as fallback, but the operator got no signal).
    After the polish the warning fires and `explicit=None` is the
    explicit fallback signal."""

    def fake_smart_paths(*args, **kwargs):
        return []  # built but no matches

    monkeypatch.setattr("claudestruct.indexer.smart_paths", fake_smart_paths)

    result = _runner().invoke(
        cli_mod.main,
        [
            "dev",
            "--root", str(tmp_path),
            "--smart-context",
            "--dry-run",
            "describe the change",
        ],
    )
    assert result.exit_code == 0, _stderr(result)
    assert "falling back" in _stderr(result).lower()
    # Mention `cs index build` so the operator knows the obvious fix
    # for an empty index.
    assert "cs index build" in _stderr(result).lower()


@pytest.mark.parametrize("task", ["dev", "review", "plan", "debug"])
def test_smart_context_fallback_works_across_every_task(
    monkeypatch, tmp_path, task: str,
):
    """The fallback branch is shared across the four task commands;
    a regression in any one of them is unlikely but the parametrize
    is cheap insurance against `_run_common` divergence."""

    def fake_smart_paths(*args, **kwargs):
        raise EmbeddingError("nope")

    monkeypatch.setattr("claudestruct.indexer.smart_paths", fake_smart_paths)
    args = [task, "--root", str(tmp_path), "--smart-context", "--dry-run"]
    if task != "review":
        args.append("desc")
    result = _runner().invoke(cli_mod.main, args)
    assert result.exit_code == 0, (
        f"task={task} should fall back gracefully; got "
        f"exit={result.exit_code} stderr={_stderr(result)}"
    )
