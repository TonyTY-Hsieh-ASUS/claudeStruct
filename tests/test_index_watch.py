"""Tests for `claudestruct.indexer.watch_index` (W10.5d — watch mode).

Watch mode is a poll loop around `build_index`. We test:
  - max_iterations bounds the loop (so the test doesn't run forever).
  - Sleep is invoked between iterations (lets a future operator
    actually slow down or speed up the watcher).
  - Sha-skip on the second pass means embedded count drops to 0
    when files don't change (the whole point of the design).
  - EmbeddingError on one pass doesn't kill the loop — next pass
    retries.
"""
from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path

import pytest

from claudestruct import indexer as indexer_mod
from claudestruct.embed import EmbeddingError


@dataclass
class _FakeEmbed:
    """Same deterministic stub used by tests/test_index.py."""

    dim: int = 8

    def embed_batch(self, texts: Sequence[str]) -> list[list[float]]:
        out: list[list[float]] = []
        for t in texts:
            v = [0.0] * self.dim
            v[abs(hash(t)) % self.dim] = 1.0
            out.append(v)
        return out


def _make_repo(tmp_path: Path) -> Path:
    repo = tmp_path / "repo"
    repo.mkdir()
    (repo / "alpha.py").write_text("def alpha(): return 1\n")
    (repo / "beta.py").write_text("def beta(): return 2\n")
    return repo


def test_watch_index_runs_max_iterations(tmp_path: Path):
    """The bounded-iteration knob is the test surface — production
    callers omit it and the loop runs forever until SIGINT."""
    repo = _make_repo(tmp_path)
    n = indexer_mod.watch_index(
        repo,
        client=_FakeEmbed(),
        index_root=tmp_path / "idx",
        max_iterations=3,
        sleep=lambda _s: None,
    )
    assert n == 3


def test_watch_index_sleeps_between_iterations(tmp_path: Path):
    """The sleep injection point is what lets `--interval N` actually
    do anything; lock that the loop calls it once per gap (so 3 passes
    = 2 sleeps; the test caps at max_iterations BEFORE the final
    sleep)."""
    repo = _make_repo(tmp_path)
    sleeps: list[float] = []

    def fake_sleep(s: float) -> None:
        sleeps.append(s)

    indexer_mod.watch_index(
        repo,
        client=_FakeEmbed(),
        index_root=tmp_path / "idx",
        interval_s=0.42,
        max_iterations=3,
        sleep=fake_sleep,
    )
    # 3 iterations → 2 inter-iteration sleeps. The post-loop sleep
    # is short-circuited by the max_iterations check.
    assert sleeps == [0.42, 0.42]


def test_watch_index_second_pass_skips_unchanged_files(tmp_path: Path):
    """The whole point of the design: a no-op pass costs nothing
    embedding-wise. Locks the sha-skip behaviour at the watch layer
    so a future refactor that loses sha-skip would break this test
    (not just `build_index`'s direct test)."""
    repo = _make_repo(tmp_path)
    embed_calls: list[int] = []

    class CountingEmbed(_FakeEmbed):
        def embed_batch(self, texts: Sequence[str]) -> list[list[float]]:
            embed_calls.append(len(texts))
            return super().embed_batch(texts)

    indexer_mod.watch_index(
        repo,
        client=CountingEmbed(),
        index_root=tmp_path / "idx",
        max_iterations=3,
        sleep=lambda _s: None,
    )
    # First pass embeds 2 files; subsequent passes find unchanged
    # shas and embed 0 new texts. The exact sequence is what proves
    # the loop is sharing state via the disk-resident index.
    assert embed_calls == [2]


def test_watch_index_re_embeds_after_edit(tmp_path: Path):
    """The reason the watch exists: edits land in the index without
    the operator running anything. We can't actually wait for fs
    events here so we mutate the file between iterations using a
    fake sleep that fires the edit on the right cycle."""
    repo = _make_repo(tmp_path)
    embed_calls: list[int] = []

    class CountingEmbed(_FakeEmbed):
        def embed_batch(self, texts: Sequence[str]) -> list[list[float]]:
            embed_calls.append(len(texts))
            return super().embed_batch(texts)

    cycle = {"n": 0}

    def fake_sleep(_s: float) -> None:
        cycle["n"] += 1
        if cycle["n"] == 1:
            (repo / "alpha.py").write_text("def alpha(): return 99\n")

    indexer_mod.watch_index(
        repo,
        client=CountingEmbed(),
        index_root=tmp_path / "idx",
        max_iterations=3,
        sleep=fake_sleep,
    )
    # Pass 1 embeds 2; pass 2 (after the edit) embeds the changed
    # file only; pass 3 finds the new sha already stored and embeds
    # nothing.
    assert embed_calls == [2, 1]


def test_watch_index_survives_embedding_error(tmp_path: Path):
    """A flaky Ollama (restart, network blip) on one pass must not
    kill a long-running watch. Lock that the error is reported via
    `progress` and the loop continues."""
    repo = _make_repo(tmp_path)
    pass_n = {"n": 0}

    class FlakyEmbed(_FakeEmbed):
        def embed_batch(self, texts: Sequence[str]) -> list[list[float]]:
            pass_n["n"] += 1
            if pass_n["n"] == 1:
                raise EmbeddingError("ollama not running")
            return super().embed_batch(texts)

    progress_msgs: list[str] = []
    n = indexer_mod.watch_index(
        repo,
        client=FlakyEmbed(),
        index_root=tmp_path / "idx",
        max_iterations=2,
        sleep=lambda _s: None,
        progress=progress_msgs.append,
    )
    assert n == 2
    # Pass 1 reports the failure; pass 2 succeeds.
    assert any("embedding endpoint failed" in m for m in progress_msgs)
    assert any("embedded 2" in m for m in progress_msgs)


def test_watch_index_progress_callback_optional(tmp_path: Path):
    """The CLI passes a printer; tests sometimes don't. Make sure
    `progress=None` doesn't crash when build_index succeeds OR
    fails."""
    repo = _make_repo(tmp_path)

    class FailFirstEmbed(_FakeEmbed):
        def __init__(self) -> None:
            super().__init__()
            self.first = True

        def embed_batch(self, texts: Sequence[str]) -> list[list[float]]:
            if self.first:
                self.first = False
                raise EmbeddingError("transient")
            return super().embed_batch(texts)

    n = indexer_mod.watch_index(
        repo,
        client=FailFirstEmbed(),
        index_root=tmp_path / "idx",
        max_iterations=2,
        sleep=lambda _s: None,
        progress=None,
    )
    assert n == 2


def test_watch_index_zero_iterations_returns_immediately(tmp_path: Path):
    """A defensive case: max_iterations=0 should be a no-op. Without
    this guard a misconfigured caller would get one full pass
    before the cap kicked in."""
    repo = _make_repo(tmp_path)
    embed_calls: list[int] = []

    class CountingEmbed(_FakeEmbed):
        def embed_batch(self, texts: Sequence[str]) -> list[list[float]]:
            embed_calls.append(len(texts))
            return super().embed_batch(texts)

    n = indexer_mod.watch_index(
        repo,
        client=CountingEmbed(),
        index_root=tmp_path / "idx",
        max_iterations=0,
        sleep=lambda _s: pytest.fail("sleep should not run"),
    )
    assert n == 0
    assert embed_calls == []
