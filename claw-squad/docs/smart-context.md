# `claw-squad` smart-context

Local embedding index that lets the Coder / Reviewer agents pull
top-K semantically-relevant files instead of relying on keyword rank
alone. The biggest payoff is on local 32B models — `Qwen2.5-Coder-32B`
on a GX10 has a 32K context window vs. cloud Sonnet's 200K, so file
selection quality matters a lot more.

This doc covers the **index management surface**. Wiring the
`--smart-context` flag into `claw-squad run` itself is a focused
follow-up; this PR ships the data foundation so the orchestrator
integration lands as a small change with the heavy lifting already
in place.

## Setup

```bash
# Pick an embedding endpoint. The defaults assume Ollama on the same
# host with `nomic-embed-text` already pulled — the same setup the
# Python-side `cs index` uses. The two indexes are independent (one
# at ~/.claudestruct/index/, one at ~/.claw-squad/index/) so they
# can drift if you point them at different models.
ollama pull nomic-embed-text

# Optional overrides (env vars; defaults shown):
export CLAW_SQUAD_EMBED_BASE_URL=http://localhost:11434/v1
export CLAW_SQUAD_EMBED_MODEL=nomic-embed-text
# Cloud OpenAI works the same way:
# export CLAW_SQUAD_EMBED_BASE_URL=https://api.openai.com/v1
# export CLAW_SQUAD_EMBED_MODEL=text-embedding-3-small
# export CLAW_SQUAD_EMBED_API_KEY=$OPENAI_API_KEY
```

## Build the index

```bash
node dist/cli.js index build
# walked 1240 file(s); embedded 1240; skipped 0 unchanged, 0 unreadable

# Inspect:
node dist/cli.js index stats
# entries: 1240
# dimension: 768

# Nuke and start over:
node dist/cli.js index clear
```

The index lands at `~/.claw-squad/index/<repo-fingerprint>.jsonl`
(override via `CLAW_SQUAD_INDEX_DIR`). The fingerprint is a SHA-256
of the absolute repo path, so two checkouts of the same project
get separate indexes — safe to switch branches/worktrees without
thrashing one shared file.

Re-running `index build` is cheap: each file's SHA-256 is compared
against the stored value, and only changed/new files are re-embedded.
Wire it into a git hook or `scripts/nightly-review.sh` to keep the
index warm without thinking about it.

## Why JSONL on disk (not SQLite)

The Python side uses SQLite. We deliberately picked JSONL here:

- **Zero native deps.** `better-sqlite3` ships compiled binaries
  that fail to install on Alpine / Termux / restricted CI more
  often than we want to debug. The smart-context surface should be
  `pnpm install`-able everywhere claw-squad already runs.
- **Append-friendly.** Most operations are "embed a few new files,
  rewrite the file." JSONL fits that shape natively; SQLite's value
  here would be over-engineered.
- **Pure-JS cosine** over ~10k rows × 768-1024 dims runs in 100-300 ms
  on a GX10 — well inside the latency budget for a one-shot query.

When the index outgrows that — multi-monorepo deployments,
hundreds of thousands of files — the storage layer is the right
swap, not the algorithm. `Index.query` is the seam.

## Use the index in a `run`

```bash
claw-squad run --smart-context "wire the billing webhook into the worker queue"
```

For each TODO, the orchestrator queries the index with
`title + "\n" + description`, takes the top-K (k=20) hits, and feeds
them to the existing `gatherInitialContext` ahead of the keyword-rank
results. The per-file / per-byte budgets still clamp the final set,
so a giant top-K can't blow out the Coder's prompt.

If the index is empty or the embedding endpoint is unreachable, the
orchestrator logs a one-liner and falls back to keyword rank — runs
never abort because of smart-context alone.

## What's next

- **Cross-tool index sharing** — have `cs index build` and
  `claw-squad index build` write to a common directory + format so
  one process pays the embedding cost. The two SHAs differ today
  by storage shape only; the embedding model + per-file cap are
  identical, so the data is convertible.
- **Watch mode** — auto-rebuild on file save / git checkout.
- **Reviewer-side integration** — apply the same top-K trick when
  building the Reviewer's diff context for the rare case where the
  Reviewer needs sibling files beyond the diff.
