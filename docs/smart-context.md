# `--smart-context`: semantic file selection (W10.5)

The default `cs dev/review/plan/debug` walk picks files via globs +
`git status` / `git diff`. That works well on a focused diff but
degrades on large monorepos: a description like *"plan how to add
billing webhooks"* can't tell glob walking which 50 of 50 000 files
matter.

`--smart-context` swaps that walk for a top-K embedding-similarity
query against a local index. Designed to land natively on a GX10's
128 GB unified memory: index + embedding model + Coder LLM all fit
concurrently.

## Setup

```bash
pip install 'claudestruct[smart-context]'

# Pick an embedding endpoint. The defaults assume Ollama on the same
# host with `nomic-embed-text` already pulled:
ollama pull nomic-embed-text
# (Optional) override:
export CLAUDESTRUCT_EMBED_BASE_URL=http://localhost:11434/v1
export CLAUDESTRUCT_EMBED_MODEL=nomic-embed-text
```

Cloud OpenAI works the same way:

```bash
export CLAUDESTRUCT_EMBED_BASE_URL=https://api.openai.com/v1
export CLAUDESTRUCT_EMBED_MODEL=text-embedding-3-small
export CLAUDESTRUCT_EMBED_API_KEY=$OPENAI_API_KEY
```

## Build the index

```bash
cs index build [--root .]
# walked 1240 file(s); embedded 1240; skipped 0 unchanged, 0 unreadable
```

The index lands at `~/.claudestruct/index/<repo-fingerprint>.db`
(override via `CLAUDESTRUCT_INDEX_DIR`). The fingerprint is a hash of
the absolute repo path, so two checkouts of the same project — even
forks — get separate indexes.

Re-running `cs index build` is cheap: each file's SHA-256 is compared
against the stored value, and only changed/new files are re-embedded.
Wire it into a git hook or `scripts/nightly-review.sh` to keep the
index warm without thinking about it.

```bash
# Inspect:
cs index stats
# entries: 1240
# dimension: 768

# Nuke and start over:
cs index clear
```

## Use the index

Pass `--smart-context` to any of the four task commands:

```bash
cs dev --smart-context "wire the billing webhook into the worker queue"
cs review --smart-context "tenant-isolation on the runs endpoint"
cs plan --smart-context "design the multi-region deployment"
cs debug --smart-context "test_x is failing intermittently after the migration"
```

Under the hood:

1. The task description becomes one embedding vector.
2. Cosine similarity ranks every file in the index.
3. Top-K (default 20) files become the gatherer's `explicit_paths`.
4. The existing per-task budget (`--max-bytes`, defaults from
   `BUDGETS_PER_TASK`) trims that list down to fit the prompt cache.

If the embedding endpoint is unreachable, `--smart-context` exits 2
with a clear message — runs never silently fall back to the wrong
context source.

## Failure modes

| Symptom | Cause | Fix |
|---------|-------|-----|
| `--smart-context: embed endpoint unreachable …; falling back to keyword/diff walk` | Ollama not running, wrong port | `ollama serve`, or set `CLAUDESTRUCT_EMBED_BASE_URL` (the run still proceeds with the default gatherer) |
| `--smart-context: index returned no hits; falling back …` | Forgot `cs index build` | Run it once; subsequent runs are incremental |
| `embedding dim mismatch: 768 vs 1024` | Two embedding models in one index | `cs index clear` then rebuild with one model |
| Slow first build | First-time embed of a 50k-file monorepo | Expected; subsequent builds skip unchanged |

`--smart-context` is **best-effort**: when the embedding endpoint
is unreachable or the index is empty, the run prints a yellow warning
and falls back to the same keyword/diff gatherer it'd use without
the flag. This matches `claw-squad run --smart-context` behaviour and
means a flaky Ollama can't hard-abort an otherwise-fine run.

## What's next

- **sqlite-vec**: pure-Python cosine is plenty for a single repo's
  files. When the index passes ~100k entries, dropping in
  [sqlite-vec](https://github.com/asg017/sqlite-vec) shaves the query
  from ~300 ms to ~5 ms. Behind `Index.query`, no caller change.
- **Hybrid retrieval**: combine semantic top-K with keyword BM25 for
  the cases where the description literally names a file.
- **claw-squad integration**: same index, exposed to the Coder /
  Reviewer agents as a tool call rather than baked into `cs dev`.

Each is a follow-up; W10.5 ships the foundation.
