"""Tests for `claudestruct.index` and `claudestruct.indexer` (W10.5)."""
from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path

import pytest

from claudestruct import index as index_mod
from claudestruct import indexer as indexer_mod

# --- Index storage --------------------------------------------------


def test_index_round_trip(tmp_path: Path):
    with index_mod.Index.open(tmp_path, index_root=tmp_path / "idx") as idx:
        idx.upsert("foo.py", sha256="aaa", embedding=[0.1, 0.2, 0.3])
        assert idx.get_sha("foo.py") == "aaa"
        assert idx.stats().entries == 1
        assert idx.stats().dimension == 3


def test_index_upsert_replaces_existing_row(tmp_path: Path):
    """Re-running `cs index build` after editing a file must overwrite,
    not duplicate. SHA changes with content; old row must lose."""
    with index_mod.Index.open(tmp_path, index_root=tmp_path / "idx") as idx:
        idx.upsert("foo.py", sha256="v1", embedding=[1.0, 0.0])
        idx.upsert("foo.py", sha256="v2", embedding=[0.0, 1.0])
        assert idx.stats().entries == 1
        assert idx.get_sha("foo.py") == "v2"


def test_index_stats_empty_dim_zero(tmp_path: Path):
    with index_mod.Index.open(tmp_path, index_root=tmp_path / "idx") as idx:
        s = idx.stats()
        assert s.entries == 0 and s.dimension == 0


def test_index_clear(tmp_path: Path):
    with index_mod.Index.open(tmp_path, index_root=tmp_path / "idx") as idx:
        idx.upsert("a.py", sha256="x", embedding=[1.0])
        idx.upsert("b.py", sha256="y", embedding=[1.0])
        deleted = idx.clear()
        assert deleted == 2
        assert idx.stats().entries == 0


def test_index_per_repo_fingerprint(tmp_path: Path):
    """Two different repo roots must land on two different files —
    otherwise upserting one stomps the other."""
    a = tmp_path / "a"
    b = tmp_path / "b"
    a.mkdir()
    b.mkdir()
    pa = index_mod.index_path(a, index_root=tmp_path / "idx")
    pb = index_mod.index_path(b, index_root=tmp_path / "idx")
    assert pa != pb


def test_index_path_respects_env(tmp_path: Path, monkeypatch):
    """`CLAUDESTRUCT_INDEX_DIR` must be honored so operators can put
    the index on a different mount (e.g. fast NVMe)."""
    monkeypatch.setenv("CLAUDESTRUCT_INDEX_DIR", str(tmp_path / "custom"))
    p = index_mod.index_path(tmp_path)
    assert p.parent == tmp_path / "custom"


# --- Cosine ranking -------------------------------------------------


def test_query_returns_nearest_first(tmp_path: Path):
    with index_mod.Index.open(tmp_path, index_root=tmp_path / "idx") as idx:
        # All on the unit circle in 2D so cosine == cos(angle).
        idx.upsert("east.py",  sha256="e", embedding=[1.0, 0.0])
        idx.upsert("ne.py",    sha256="n", embedding=[math.sqrt(0.5), math.sqrt(0.5)])
        idx.upsert("north.py", sha256="N", embedding=[0.0, 1.0])
        # Query points east → east.py wins, ne.py second, north.py last.
        hits = idx.query([1.0, 0.0], k=3)
        assert [h.rel_path for h in hits] == ["east.py", "ne.py", "north.py"]
        assert hits[0].score == pytest.approx(1.0)
        assert hits[2].score == pytest.approx(0.0, abs=1e-9)


def test_query_respects_k(tmp_path: Path):
    with index_mod.Index.open(tmp_path, index_root=tmp_path / "idx") as idx:
        for i in range(5):
            idx.upsert(f"f{i}.py", sha256=str(i), embedding=[1.0, 0.0])
        hits = idx.query([1.0, 0.0], k=3)
        assert len(hits) == 3


def test_query_zero_vector_returns_empty(tmp_path: Path):
    """Cosine is undefined when the query has zero norm. Don't crash;
    don't return junk."""
    with index_mod.Index.open(tmp_path, index_root=tmp_path / "idx") as idx:
        idx.upsert("a.py", sha256="x", embedding=[1.0, 0.0])
        assert idx.query([0.0, 0.0]) == []


def test_query_skips_zero_norm_rows(tmp_path: Path):
    """Defensive: a degenerate row (all zeros) used to crash with
    ZeroDivisionError. Lock the skip behaviour."""
    with index_mod.Index.open(tmp_path, index_root=tmp_path / "idx") as idx:
        idx.upsert("good.py", sha256="g", embedding=[1.0, 0.0])
        idx.upsert("zero.py", sha256="z", embedding=[0.0, 0.0])
        hits = idx.query([1.0, 0.0], k=5)
        assert [h.rel_path for h in hits] == ["good.py"]


def test_query_dim_mismatch_raises(tmp_path: Path):
    """Mixing two embedding models in one index produces nonsense
    scores; raise loud rather than silently truncate."""
    with index_mod.Index.open(tmp_path, index_root=tmp_path / "idx") as idx:
        idx.upsert("a.py", sha256="x", embedding=[1.0, 0.0, 0.5])
        with pytest.raises(ValueError, match="dim mismatch"):
            idx.query([1.0, 0.0], k=1)


# --- file_sha256 -----------------------------------------------------


def test_file_sha256_stable():
    a = index_mod.file_sha256(b"hello")
    b = index_mod.file_sha256(b"hello")
    assert a == b
    assert len(a) == 64


def test_file_sha256_changes_with_content():
    assert index_mod.file_sha256(b"a") != index_mod.file_sha256(b"b")


# --- Indexer (build + smart_paths) ---------------------------------


@dataclass
class _FakeEmbed:
    """Deterministic stand-in for a real embedding endpoint. Returns
    a unit vector that points along axis ``hash(text) % dim``. Lets
    us test ranking without spinning up Ollama."""

    dim: int = 8

    def embed_batch(self, texts: Sequence[str]) -> list[list[float]]:
        out: list[list[float]] = []
        for t in texts:
            v = [0.0] * self.dim
            v[abs(hash(t)) % self.dim] = 1.0
            out.append(v)
        return out


def _make_repo(tmp_path: Path) -> Path:
    """Minimal repo: two source files, no .git (the indexer uses the
    pathspec from .gitignore but doesn't require the repo to be a
    proper git checkout)."""
    repo = tmp_path / "repo"
    repo.mkdir()
    (repo / "alpha.py").write_text("def alpha(): return 1\n")
    (repo / "beta.py").write_text("def beta(): return 2\n")
    return repo


def test_build_index_walks_and_embeds(tmp_path: Path):
    repo = _make_repo(tmp_path)
    fake = _FakeEmbed()
    stats = indexer_mod.build_index(
        repo, client=fake, index_root=tmp_path / "idx",
    )
    assert stats.walked == 2
    assert stats.embedded == 2
    assert stats.skipped_unchanged == 0
    with index_mod.Index.open(repo, index_root=tmp_path / "idx") as idx:
        assert idx.stats().entries == 2


def test_build_index_skips_unchanged_files(tmp_path: Path):
    """Second build of the same repo should re-walk but not re-embed."""
    repo = _make_repo(tmp_path)
    fake = _FakeEmbed()
    indexer_mod.build_index(repo, client=fake, index_root=tmp_path / "idx")
    second = indexer_mod.build_index(repo, client=fake, index_root=tmp_path / "idx")
    assert second.walked == 2
    assert second.embedded == 0
    assert second.skipped_unchanged == 2


def test_build_index_re_embeds_after_edit(tmp_path: Path):
    repo = _make_repo(tmp_path)
    fake = _FakeEmbed()
    indexer_mod.build_index(repo, client=fake, index_root=tmp_path / "idx")
    (repo / "alpha.py").write_text("def alpha(): return 99\n")
    second = indexer_mod.build_index(repo, client=fake, index_root=tmp_path / "idx")
    assert second.embedded == 1
    assert second.skipped_unchanged == 1


def test_smart_paths_returns_top_k_files(tmp_path: Path):
    repo = _make_repo(tmp_path)
    fake = _FakeEmbed()
    indexer_mod.build_index(repo, client=fake, index_root=tmp_path / "idx")
    paths = indexer_mod.smart_paths(
        repo, "alpha", k=1, client=fake, index_root=tmp_path / "idx",
    )
    assert len(paths) == 1
    assert paths[0].is_file()


def test_smart_paths_empty_index_returns_empty(tmp_path: Path):
    repo = tmp_path / "empty"
    repo.mkdir()
    fake = _FakeEmbed()
    paths = indexer_mod.smart_paths(
        repo, "anything", k=5, client=fake, index_root=tmp_path / "idx",
    )
    assert paths == []


# --- Embedding client wire-format -----------------------------------


def test_embedding_client_default_factory_reads_env(monkeypatch):
    """Smoke test: env passthrough. The actual HTTP path is too
    expensive to test without a server; this guards the config glue."""
    from claudestruct.embed import default_client

    monkeypatch.setenv("CLAUDESTRUCT_EMBED_BASE_URL", "http://example:9/v1")
    monkeypatch.setenv("CLAUDESTRUCT_EMBED_MODEL", "my-embed")
    monkeypatch.setenv("CLAUDESTRUCT_EMBED_API_KEY", "sk-test")
    c = default_client()
    assert c.base_url == "http://example:9/v1"
    assert c.model == "my-embed"
    assert c.api_key == "sk-test"


def test_embedding_client_default_factory_no_api_key(monkeypatch):
    """A missing key should leave the field None (not the empty
    string) — Authorization header is omitted then."""
    from claudestruct.embed import default_client

    monkeypatch.delenv("CLAUDESTRUCT_EMBED_API_KEY", raising=False)
    c = default_client()
    assert c.api_key is None


def test_embedding_client_empty_input_short_circuits():
    """Empty list shouldn't fire an HTTP call. Saves one round-trip
    on the common "no candidate files" path."""
    from claudestruct.embed import EmbeddingClient

    c = EmbeddingClient(base_url="http://does-not-resolve.invalid:1/v1")
    assert c.embed_batch([]) == []
