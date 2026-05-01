"""Local embedding client (W10.5 — RAG smart context).

Talks to any OpenAI-compatible ``/embeddings`` endpoint via stdlib
``urllib`` — Ollama (`/v1/embeddings`), vLLM, SGLang, llama.cpp's
server, even cloud OpenAI all expose the same wire format. We
deliberately avoid pulling in ``httpx`` / ``requests`` so the
``[smart-context]`` extra stays small.

Why a dedicated client instead of reusing ``providers.OpenAICompatProvider``?
Embeddings are batch-friendly (`input` is a list) and don't stream;
generation is single-string and stream-first. Forcing one abstraction to
serve both produces noise — the modules share concept, not code.

Configuration (all env vars; defaults target Ollama on a GX10):

  CLAUDESTRUCT_EMBED_BASE_URL   default ``http://localhost:11434/v1``
  CLAUDESTRUCT_EMBED_MODEL      default ``nomic-embed-text``
  CLAUDESTRUCT_EMBED_API_KEY    optional; only set when targeting cloud
                                OpenAI / a gateway that gates the route
"""
from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Sequence

DEFAULT_BASE_URL = "http://localhost:11434/v1"
DEFAULT_MODEL = "nomic-embed-text"


class EmbeddingError(RuntimeError):
    """Raised when the embedding endpoint can't be reached or returns
    a malformed response. Caller decides whether to abort the build or
    skip the offending file."""


@dataclass
class EmbeddingClient:
    """OpenAI-compatible ``/embeddings`` POSTer. Stateless; reuse one
    instance across an indexing run for connection-keep-alive savings
    (urllib reuses sockets transparently when feasible)."""

    base_url: str = DEFAULT_BASE_URL
    model: str = DEFAULT_MODEL
    api_key: str | None = None
    timeout_s: float = 30.0

    def embed_batch(self, texts: Sequence[str]) -> list[list[float]]:
        """Embed a batch of texts. Empty input returns an empty list —
        callers walking files often want this fast-path so they don't
        special-case the "no matching files" branch.
        """
        if not texts:
            return []
        url = self.base_url.rstrip("/") + "/embeddings"
        body = json.dumps({"model": self.model, "input": list(texts)}).encode("utf-8")
        headers = {"content-type": "application/json"}
        if self.api_key:
            headers["authorization"] = f"Bearer {self.api_key}"
        req = urllib.request.Request(url, data=body, headers=headers, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=self.timeout_s) as resp:
                raw = resp.read()
        except urllib.error.HTTPError as exc:
            raise EmbeddingError(
                f"embeddings endpoint returned HTTP {exc.code}: {exc.reason}"
            ) from exc
        except urllib.error.URLError as exc:
            raise EmbeddingError(
                f"embeddings endpoint unreachable at {url}: {exc.reason}"
            ) from exc
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise EmbeddingError("embeddings response was not JSON") from exc
        data = payload.get("data")
        if not isinstance(data, list):
            raise EmbeddingError(
                f"embeddings response missing 'data' array: {payload!r}"
            )
        out: list[list[float]] = []
        for i, row in enumerate(data):
            emb = row.get("embedding") if isinstance(row, dict) else None
            if not isinstance(emb, list):
                raise EmbeddingError(
                    f"embeddings response row {i} missing 'embedding' list"
                )
            out.append([float(x) for x in emb])
        if len(out) != len(texts):
            raise EmbeddingError(
                f"embeddings response returned {len(out)} vectors for "
                f"{len(texts)} inputs — server bug, refusing to align"
            )
        return out


def default_client() -> EmbeddingClient:
    """Build the client from env. Used by ``cs index build`` and the
    ``--smart-context`` query path."""
    return EmbeddingClient(
        base_url=os.environ.get("CLAUDESTRUCT_EMBED_BASE_URL", DEFAULT_BASE_URL),
        model=os.environ.get("CLAUDESTRUCT_EMBED_MODEL", DEFAULT_MODEL),
        api_key=os.environ.get("CLAUDESTRUCT_EMBED_API_KEY") or None,
    )
