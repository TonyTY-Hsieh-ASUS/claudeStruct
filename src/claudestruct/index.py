"""Local embedding index for smart-context retrieval (W10.5).

Stores `(path, content_sha256, embedding)` rows in a SQLite db at
``~/.claudestruct/index/<repo-fingerprint>.db`` — one db per repo so
upserting one repo never invalidates another's index.

We deliberately avoid sqlite-vec / hnswlib for the first pass:

* sqlite-vec ships as a C extension that fails to build on more
  surfaces than we want to debug (Alpine containers, restricted CI,
  Windows). The ``[smart-context]`` extra should be ``pip install``-able
  on every platform claudestruct already runs on.
* Pure-Python cosine over ~10k embeddings (768-1024 dim) takes
  100-300 ms — well inside the latency budget for a one-shot
  ``cs review --smart-context`` query.

When the index outgrows that — multi-monorepo deployments, hundreds of
thousands of files — swapping the storage layer for sqlite-vec is a
drop-in change behind ``Index.query`` and doesn't ripple.
"""
from __future__ import annotations

import hashlib
import json
import math
import os
import sqlite3
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from pathlib import Path


def _repo_fingerprint(root: Path) -> str:
    """Stable per-repo id used as the db filename. We hash the absolute
    path rather than git remote URL so a checkout under a different
    path (or a fork) gets its own index — the alternative would mean
    two unrelated checkouts thrash the same file."""
    return hashlib.sha256(str(root.resolve()).encode("utf-8")).hexdigest()[:16]


def _default_index_root() -> Path:
    """``~/.claudestruct/index/``. Override via
    ``CLAUDESTRUCT_INDEX_DIR``."""
    explicit = os.environ.get("CLAUDESTRUCT_INDEX_DIR", "").strip()
    if explicit:
        return Path(explicit).expanduser()
    return Path.home() / ".claudestruct" / "index"


def index_path(root: Path, *, index_root: Path | None = None) -> Path:
    base = index_root or _default_index_root()
    return base / f"{_repo_fingerprint(root)}.db"


# --- Stats / row types ----------------------------------------------


@dataclass(frozen=True)
class IndexStats:
    entries: int
    dimension: int  # 0 when empty


@dataclass(frozen=True)
class QueryHit:
    """One result row from ``Index.query``. ``rel_path`` is whatever
    the caller stored — usually a repo-relative POSIX path so the
    downstream gatherer can match it against ``Path.relative_to``.

    ``score`` is cosine similarity in [-1, 1]; closer to 1 = more
    similar."""

    rel_path: str
    score: float


# --- Index ----------------------------------------------------------


_SCHEMA = """
CREATE TABLE IF NOT EXISTS entries (
    rel_path  TEXT PRIMARY KEY,
    sha256    TEXT NOT NULL,
    embedding TEXT NOT NULL  -- JSON-encoded list[float]
);
"""


class Index:
    """Open or create an index for the given path. Used as a context
    manager so the SQLite connection closes deterministically:

        with Index.open(repo_root) as idx:
            idx.upsert(...)
    """

    def __init__(self, conn: sqlite3.Connection):
        self._conn = conn

    @classmethod
    def open(cls, root: Path, *, index_root: Path | None = None) -> Index:
        path = index_path(root, index_root=index_root)
        path.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(path)
        conn.executescript(_SCHEMA)
        return cls(conn)

    def __enter__(self) -> Index:
        return self

    def __exit__(self, *exc) -> None:
        self.close()

    def close(self) -> None:
        self._conn.close()

    # --- Mutation -------------------------------------------------

    def upsert(
        self,
        rel_path: str,
        *,
        sha256: str,
        embedding: Sequence[float],
    ) -> None:
        """Insert or replace. We don't dedupe by sha256 here — callers
        do that check before embedding so we don't waste API calls on
        unchanged files. ``Index`` only guards the storage layer."""
        self._conn.execute(
            "INSERT OR REPLACE INTO entries(rel_path, sha256, embedding) "
            "VALUES (?, ?, ?)",
            (rel_path, sha256, json.dumps(list(embedding))),
        )
        self._conn.commit()

    def upsert_many(
        self,
        rows: Iterable[tuple[str, str, Sequence[float]]],
    ) -> int:
        """Bulk variant — single transaction. Returns the number of
        rows written. Callers should pass an iterable of
        ``(rel_path, sha256, embedding)`` triples."""
        n = 0
        cur = self._conn.cursor()
        for rel_path, sha256, embedding in rows:
            cur.execute(
                "INSERT OR REPLACE INTO entries(rel_path, sha256, embedding) "
                "VALUES (?, ?, ?)",
                (rel_path, sha256, json.dumps(list(embedding))),
            )
            n += 1
        self._conn.commit()
        return n

    # --- Read -----------------------------------------------------

    def get_sha(self, rel_path: str) -> str | None:
        """Return the stored sha for a path, or ``None`` if absent.
        Lets the indexer skip re-embedding unchanged files."""
        row = self._conn.execute(
            "SELECT sha256 FROM entries WHERE rel_path = ?", (rel_path,)
        ).fetchone()
        return row[0] if row else None

    def stats(self) -> IndexStats:
        n = self._conn.execute("SELECT COUNT(*) FROM entries").fetchone()[0]
        if n == 0:
            return IndexStats(entries=0, dimension=0)
        first = self._conn.execute("SELECT embedding FROM entries LIMIT 1").fetchone()
        dim = len(json.loads(first[0])) if first else 0
        return IndexStats(entries=n, dimension=dim)

    def clear(self) -> int:
        """Drop every row. Returns the count for caller messaging."""
        n = self._conn.execute("SELECT COUNT(*) FROM entries").fetchone()[0]
        self._conn.execute("DELETE FROM entries")
        self._conn.commit()
        return n

    def query(
        self,
        vector: Sequence[float],
        *,
        k: int = 20,
    ) -> list[QueryHit]:
        """Return the top-K rows by cosine similarity to ``vector``.

        O(N) over the table. For the deployments W10.5 targets — a
        single repo's worth of files, tens of thousands at most — that
        runs in well under a second. If the index grows past that the
        storage layer is the right swap, not the algorithm.
        """
        norm_q = _norm(vector)
        if norm_q == 0:
            return []
        scored: list[tuple[float, str]] = []
        for rel_path, emb_json in self._conn.execute(
            "SELECT rel_path, embedding FROM entries"
        ):
            emb = json.loads(emb_json)
            n = _norm(emb)
            if n == 0:
                continue
            score = _dot(vector, emb) / (norm_q * n)
            scored.append((score, rel_path))
        scored.sort(key=lambda t: t[0], reverse=True)
        return [QueryHit(rel_path=p, score=s) for s, p in scored[:k]]


# --- Math helpers ---------------------------------------------------
#
# Hoisted as module-level so tests can monkey-patch / sanity-check
# without poking inside Index. Standalone, plain-list inputs.


def _dot(a: Sequence[float], b: Sequence[float]) -> float:
    if len(a) != len(b):
        # Different-dimension embeddings shouldn't happen if you stick
        # to one model per index, but if they do we want a clean error
        # — silently truncating produces nonsense scores.
        raise ValueError(
            f"embedding dim mismatch: {len(a)} vs {len(b)}; rebuild the index"
        )
    return sum(x * y for x, y in zip(a, b, strict=True))


def _norm(a: Sequence[float]) -> float:
    return math.sqrt(sum(x * x for x in a))


# --- File-content fingerprint --------------------------------------


def file_sha256(content: bytes) -> str:
    """SHA-256 of file bytes. Lets the indexer detect "no change"
    cheaply without re-embedding. Public so tests + callers share the
    exact algorithm."""
    return hashlib.sha256(content).hexdigest()
