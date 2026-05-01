"""``cs index build`` driver — walks the repo, embeds each source
file, and upserts the index. Public surface so tests and the CLI can
both call it without re-implementing the loop.
"""
from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

from claudestruct.context import _load_gitignore, _walk_source_files
from claudestruct.embed import EmbeddingClient, default_client
from claudestruct.index import Index, file_sha256

# Per-batch size for /embeddings POSTs. Most servers (Ollama, vLLM,
# OpenAI cloud) accept up to ~2048 inputs in one request, but smaller
# batches give better incremental progress + cap the blast radius of
# a single 5xx. 16 keeps the wall time down for a fresh index without
# being painful when one chunk is big.
_BATCH = 16

# Cap how much of each file we embed. Embedding models truncate
# anyway (nomic-embed-text is 8192 tokens ≈ 32 KB); keeping a tighter
# cap here shrinks the request payload and avoids fingerprint churn
# from trailing-whitespace edits in long files.
_MAX_FILE_BYTES = 16 * 1024


@dataclass
class IndexBuildStats:
    """Returned by ``build_index`` so the CLI prints meaningful
    numbers without a second walk."""

    walked: int
    embedded: int
    skipped_unchanged: int
    skipped_unreadable: int


def _read_capped(path: Path) -> bytes | None:
    """Read the first ``_MAX_FILE_BYTES`` of a file. Returns ``None``
    on permission / IO error so the indexer can carry on past one
    bad file."""
    try:
        with path.open("rb") as fh:
            return fh.read(_MAX_FILE_BYTES)
    except OSError:
        return None


def build_index(
    root: Path,
    *,
    client: EmbeddingClient | None = None,
    progress: Callable[[str], None] | None = None,
    index_root: Path | None = None,
) -> IndexBuildStats:
    """Build (or refresh) the index for ``root``.

    Skips files whose sha256 matches what's already stored — that's
    the "fast subsequent build" path. Pass ``progress`` to surface
    per-batch milestones to a UI; tests pass ``None``.
    """
    embed = client or default_client()
    spec = _load_gitignore(root)
    files = _walk_source_files(root, spec)

    walked = len(files)
    embedded = 0
    skipped_unchanged = 0
    skipped_unreadable = 0

    pending_paths: list[str] = []
    pending_shas: list[str] = []
    pending_texts: list[str] = []

    with Index.open(root, index_root=index_root) as idx:
        def _flush() -> None:
            nonlocal embedded, pending_paths, pending_shas, pending_texts
            if not pending_paths:
                return
            vectors = embed.embed_batch(pending_texts)
            idx.upsert_many(zip(pending_paths, pending_shas, vectors, strict=True))
            embedded += len(pending_paths)
            if progress is not None:
                progress(f"embedded batch of {len(pending_paths)} (total: {embedded})")
            pending_paths = []
            pending_shas = []
            pending_texts = []

        for path in files:
            rel = str(path.relative_to(root)).replace("\\", "/")
            content = _read_capped(path)
            if content is None:
                skipped_unreadable += 1
                continue
            sha = file_sha256(content)
            if idx.get_sha(rel) == sha:
                skipped_unchanged += 1
                continue
            try:
                text = content.decode("utf-8", errors="replace")
            except UnicodeDecodeError:
                skipped_unreadable += 1
                continue
            pending_paths.append(rel)
            pending_shas.append(sha)
            pending_texts.append(text)
            if len(pending_paths) >= _BATCH:
                _flush()
        _flush()

    return IndexBuildStats(
        walked=walked,
        embedded=embedded,
        skipped_unchanged=skipped_unchanged,
        skipped_unreadable=skipped_unreadable,
    )


def smart_paths(
    root: Path,
    query: str,
    *,
    k: int = 20,
    client: EmbeddingClient | None = None,
    index_root: Path | None = None,
) -> list[Path]:
    """Embed ``query``, return the top-K matching repo-relative paths
    as absolute ``Path`` objects ready to feed to a gatherer's
    ``explicit_paths``. Empty index → empty list (callers fall back to
    the default gatherer behaviour)."""
    embed = client or default_client()
    [vector] = embed.embed_batch([query])
    with Index.open(root, index_root=index_root) as idx:
        hits = idx.query(vector, k=k)
    out: list[Path] = []
    for hit in hits:
        abs_path = (root / hit.rel_path).resolve()
        if abs_path.is_file():
            out.append(abs_path)
    return out
