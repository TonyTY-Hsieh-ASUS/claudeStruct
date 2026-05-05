"""Tests for `claudestruct.index_io` (cross-tool JSONL export/import).

The export/import bridge lets `cs index` and `claw-squad index`
share embeddings without each tool paying the embedding cost
separately. JSONL is the pivot format because the TS side already
uses it natively — Python-side export = SQLite → JSONL, import =
JSONL → SQLite.
"""
from __future__ import annotations

import json
from pathlib import Path

from claudestruct import index as index_mod
from claudestruct import index_io


def _populate(index_root: Path, repo: Path, rows: list[tuple[str, str, list[float]]]) -> None:
    with index_mod.Index.open(repo, index_root=index_root) as idx:
        for rel, sha, emb in rows:
            idx.upsert(rel, sha256=sha, embedding=emb)


# --- export -------------------------------------------------------


def test_export_writes_jsonl_one_row_per_entry(tmp_path: Path):
    repo = tmp_path / "repo"
    repo.mkdir()
    idx_root = tmp_path / "idx"
    _populate(idx_root, repo, [
        ("a.py", "aaa", [1.0, 0.0, 0.0]),
        ("b.py", "bbb", [0.0, 1.0, 0.0]),
    ])
    out = tmp_path / "shared.jsonl"
    stats = index_io.export_to_jsonl(repo, out, index_root=idx_root)

    assert stats.rows == 2
    assert stats.output_path == out
    lines = out.read_text(encoding="utf-8").strip().split("\n")
    assert len(lines) == 2
    rows = [json.loads(line) for line in lines]
    assert {r["relPath"] for r in rows} == {"a.py", "b.py"}
    # TS-side schema: relPath / sha256 / embedding (no other fields
    # — we don't want to leak SQLite-internal columns into the
    # cross-tool format).
    for r in rows:
        assert set(r.keys()) == {"relPath", "sha256", "embedding"}


def test_export_sorts_by_path_for_deterministic_output(tmp_path: Path):
    """Two exports against the same source state must produce
    byte-identical files. Locking the sort order keeps the diff
    reviewable when an operator is comparing index snapshots."""
    repo = tmp_path / "repo"
    repo.mkdir()
    idx_root = tmp_path / "idx"
    _populate(idx_root, repo, [
        ("zzz.py", "z", [1.0]),
        ("aaa.py", "a", [1.0]),
        ("mmm.py", "m", [1.0]),
    ])
    out = tmp_path / "out.jsonl"
    index_io.export_to_jsonl(repo, out, index_root=idx_root)
    rows = [json.loads(line) for line in out.read_text(encoding="utf-8").strip().split("\n")]
    assert [r["relPath"] for r in rows] == ["aaa.py", "mmm.py", "zzz.py"]


def test_export_preserves_embedding_values_exactly(tmp_path: Path):
    """Float round-tripping is the contract — a lossy export turns
    cosine ranking into noise."""
    repo = tmp_path / "repo"
    repo.mkdir()
    idx_root = tmp_path / "idx"
    embedding = [0.123456789, -0.987654321, 1e-9, 1.0]
    _populate(idx_root, repo, [("x.py", "x", embedding)])
    out = tmp_path / "out.jsonl"
    index_io.export_to_jsonl(repo, out, index_root=idx_root)
    row = json.loads(out.read_text(encoding="utf-8").strip())
    assert row["embedding"] == embedding


def test_export_creates_parent_dirs(tmp_path: Path):
    """`--out path/that/doesnt/exist/yet/shared.jsonl` works
    without making the operator mkdir first."""
    repo = tmp_path / "repo"
    repo.mkdir()
    idx_root = tmp_path / "idx"
    _populate(idx_root, repo, [("a.py", "x", [1.0])])
    out = tmp_path / "deep" / "nested" / "out.jsonl"
    index_io.export_to_jsonl(repo, out, index_root=idx_root)
    assert out.exists()


def test_export_empty_index_writes_empty_file(tmp_path: Path):
    """Empty result is not an error — downstream pipelines can
    `wc -l` the output without special-casing."""
    repo = tmp_path / "repo"
    repo.mkdir()
    out = tmp_path / "out.jsonl"
    stats = index_io.export_to_jsonl(repo, out, index_root=tmp_path / "idx")
    assert stats.rows == 0
    assert out.read_text(encoding="utf-8") == ""


def test_export_uses_unescaped_unicode_for_paths(tmp_path: Path):
    """Non-ASCII paths render as themselves rather than \\u escapes
    so a `grep` of the export file matches plain UTF-8 search
    strings. TS's JSON.parse accepts both forms — the unescaped
    form is smaller and friendlier."""
    repo = tmp_path / "repo"
    repo.mkdir()
    idx_root = tmp_path / "idx"
    _populate(idx_root, repo, [("中文/檔案.py", "x", [1.0])])
    out = tmp_path / "out.jsonl"
    index_io.export_to_jsonl(repo, out, index_root=idx_root)
    raw = out.read_text(encoding="utf-8")
    assert "中文/檔案.py" in raw
    assert "\\u" not in raw  # no escape sequences


# --- import -------------------------------------------------------


def test_import_round_trips_with_export(tmp_path: Path):
    """The contract: export from one tool's index → import into
    another tool's empty index → identical row set + embeddings.
    Without this the cross-tool sharing claim is hollow."""
    repo = tmp_path / "repo"
    repo.mkdir()
    src_root = tmp_path / "src"
    dst_root = tmp_path / "dst"
    rows = [
        ("a.py", "aaa", [1.0, 0.0]),
        ("b.py", "bbb", [0.0, 1.0]),
        ("c.py", "ccc", [0.5, 0.5]),
    ]
    _populate(src_root, repo, rows)

    bridge = tmp_path / "bridge.jsonl"
    index_io.export_to_jsonl(repo, bridge, index_root=src_root)
    stats = index_io.import_from_jsonl(repo, bridge, index_root=dst_root)
    assert stats.rows == 3
    assert stats.skipped_malformed == 0

    # Verify the destination index returns the same shas + embeddings.
    with index_mod.Index.open(repo, index_root=dst_root) as idx:
        for rel, sha, _emb in rows:
            assert idx.get_sha(rel) == sha
        # Round-trip the embedding via query: a unit-vector query
        # should land exactly on the matching row.
        hits = idx.query([1.0, 0.0], k=1)
        assert hits[0].rel_path == "a.py"


def test_import_overwrites_existing_rows(tmp_path: Path):
    """Importing a JSONL with the same relPath should REPLACE the
    existing row, not duplicate. Locks the upsert semantics."""
    repo = tmp_path / "repo"
    repo.mkdir()
    idx_root = tmp_path / "idx"
    _populate(idx_root, repo, [("a.py", "old-sha", [1.0, 0.0])])

    bridge = tmp_path / "bridge.jsonl"
    bridge.write_text(
        json.dumps({"relPath": "a.py", "sha256": "new-sha", "embedding": [0.0, 1.0]}) + "\n",
        encoding="utf-8",
    )
    index_io.import_from_jsonl(repo, bridge, index_root=idx_root)

    with index_mod.Index.open(repo, index_root=idx_root) as idx:
        assert idx.stats().entries == 1
        assert idx.get_sha("a.py") == "new-sha"


def test_import_skips_malformed_lines_without_aborting(tmp_path: Path):
    """One bad line shouldn't kill the import. Locking the
    skip-and-count behaviour so a partial JSONL (truncated mid-
    transfer) still loads what's salvageable."""
    repo = tmp_path / "repo"
    repo.mkdir()
    bridge = tmp_path / "bridge.jsonl"
    bridge.write_text(
        "\n".join([
            json.dumps({"relPath": "good1.py", "sha256": "x", "embedding": [1.0]}),
            "{not-json,broken",
            json.dumps({"relPath": "missing-fields.py"}),  # no sha/embedding
            json.dumps([1, 2, 3]),  # not a dict
            json.dumps({"relPath": "good2.py", "sha256": "y", "embedding": [1.0]}),
        ]) + "\n",
        encoding="utf-8",
    )
    stats = index_io.import_from_jsonl(repo, bridge, index_root=tmp_path / "idx")
    assert stats.rows == 2
    assert stats.skipped_malformed == 3


def test_import_rejects_non_numeric_embedding_values(tmp_path: Path):
    """Defensive: the embedding column is `list[float]`. A row with
    string values inside the embedding gets counted as malformed,
    not coerced — coercion would silently produce nonsense scores."""
    repo = tmp_path / "repo"
    repo.mkdir()
    bridge = tmp_path / "bridge.jsonl"
    bridge.write_text(
        json.dumps({"relPath": "x.py", "sha256": "x", "embedding": ["1.0", "2.0"]}) + "\n",
        encoding="utf-8",
    )
    stats = index_io.import_from_jsonl(repo, bridge, index_root=tmp_path / "idx")
    assert stats.rows == 0
    assert stats.skipped_malformed == 1


def test_import_handles_empty_file(tmp_path: Path):
    repo = tmp_path / "repo"
    repo.mkdir()
    bridge = tmp_path / "bridge.jsonl"
    bridge.write_text("", encoding="utf-8")
    stats = index_io.import_from_jsonl(repo, bridge, index_root=tmp_path / "idx")
    assert stats.rows == 0
    assert stats.skipped_malformed == 0
