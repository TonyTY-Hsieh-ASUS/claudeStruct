"""Cross-tool JSONL export / import for the smart-context index.

The Python (``cs``) and TS (``claw-squad``) indexes use the same
embedding model + per-file cap, but their on-disk format differs:
SQLite vs JSONL. Re-running ``index build`` on both tools pays the
embedding cost twice. This module is the bridge:

- ``export_to_jsonl(repo_root, out_path)`` — dump the SQLite index
  to a JSONL file matching the TS-side schema
  (``{"relPath", "sha256", "embedding"}`` per line, sorted by path).
- ``import_from_jsonl(repo_root, in_path)`` — read a JSONL file (the
  TS side's storage format, or the output of ``export_to_jsonl``)
  and upsert into SQLite.

Common workflow:

    cs index build                       # Python pays the embed cost
    cs index export --out shared.jsonl
    claw-squad index import shared.jsonl  # TS reads it for free

Or in reverse: ``claw-squad index export …`` (which is essentially a
file copy on the TS side, since its native format IS JSONL) →
``cs index import``.

JSONL is the right pivot format because: (1) the TS side is already
JSONL so its export is a one-line ``cp``; (2) line-oriented JSON
streams cleanly even at 100k+ entries; (3) bad lines can be skipped
without corrupting the rest of the file.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

from claudestruct.index import Index


@dataclass(frozen=True)
class ExportStats:
    """Returned by ``export_to_jsonl`` so callers can print a useful
    summary without re-walking the file."""

    rows: int
    output_path: Path


@dataclass(frozen=True)
class ImportStats:
    """Returned by ``import_from_jsonl``. ``skipped_malformed``
    counts JSONL lines that couldn't be parsed or didn't match the
    expected shape — operators care about this when auditing why a
    transferred index has fewer rows than expected."""

    rows: int
    skipped_malformed: int
    input_path: Path


def export_to_jsonl(
    repo_root: Path,
    out_path: Path,
    *,
    index_root: Path | None = None,
) -> ExportStats:
    """Dump the index for ``repo_root`` to ``out_path`` as JSONL.

    Each line: ``{"relPath", "sha256", "embedding"}``. The output is
    sorted by ``relPath`` so two exports against the same source
    state produce byte-identical files (helps reproducibility checks
    and makes diffs across exports readable).

    The output uses ``ensure_ascii=False`` so non-ASCII paths render
    as themselves rather than ``\\u`` escapes; the TS side's
    ``JSON.parse`` accepts both forms but the unescaped form is
    smaller and easier to grep.
    """
    out_path.parent.mkdir(parents=True, exist_ok=True)
    rows = 0
    with Index.open(repo_root, index_root=index_root) as idx, \
            out_path.open("w", encoding="utf-8") as fh:
        for rel_path, sha256, embedding in idx.iter_entries():
            fh.write(
                json.dumps(
                    {"relPath": rel_path, "sha256": sha256, "embedding": embedding},
                    ensure_ascii=False,
                    separators=(",", ":"),
                ) + "\n"
            )
            rows += 1
    return ExportStats(rows=rows, output_path=out_path)


def import_from_jsonl(
    repo_root: Path,
    in_path: Path,
    *,
    index_root: Path | None = None,
) -> ImportStats:
    """Read JSONL at ``in_path`` and upsert each row into the index
    for ``repo_root``. Existing rows with the same ``relPath`` are
    overwritten — incremental import is the same as starting fresh,
    which matches the sha-skip semantics ``index build`` relies on.

    Malformed JSONL lines are skipped + counted; one bad line never
    aborts the import. Two corrupt lines mid-file is a sign the
    JSONL was concatenated or truncated mid-write — operators see
    that in the returned stats.
    """
    rows = 0
    skipped = 0
    with (
        Index.open(repo_root, index_root=index_root) as idx,
        in_path.open("r", encoding="utf-8") as fh,
    ):
        buffered: list[tuple[str, str, list[float]]] = []
        for raw in fh:
            raw = raw.strip()
            if not raw:
                continue
            try:
                obj = json.loads(raw)
            except json.JSONDecodeError:
                skipped += 1
                continue
            if not isinstance(obj, dict):
                skipped += 1
                continue
            rel = obj.get("relPath")
            sha = obj.get("sha256")
            emb = obj.get("embedding")
            if (
                not isinstance(rel, str)
                or not isinstance(sha, str)
                or not isinstance(emb, list)
                or not all(isinstance(x, (int, float)) for x in emb)
            ):
                skipped += 1
                continue
            buffered.append((rel, sha, [float(x) for x in emb]))
        # Single transaction → one fsync for the whole import,
        # not one per line. Matters when the JSONL has 50k+ rows.
        idx.upsert_many(buffered)
        rows = len(buffered)
    return ImportStats(rows=rows, skipped_malformed=skipped, input_path=in_path)
