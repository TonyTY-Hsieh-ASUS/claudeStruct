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

## Reviewer-side integration

`--smart-context` also feeds the Reviewer (W10.5b follow-up). For
each round of review, the orchestrator queries the index for top-K
files matching the todo description, drops any path that's already
covered by the diff (the Reviewer reads those bytes directly), and
passes the remaining files to the Reviewer under a "Sibling files
(context only — NOT part of the diff)" heading.

Helps the Reviewer catch "did this break the caller of the changed
function" without bloating the prompt — Reviewer caps are tighter
than the Coder's (4 files, 32 KB total, 12 KB per file) because the
diff itself is the main feed; siblings are supplementary.

If the index is empty or the embedding endpoint is unreachable, the
Reviewer falls back to seeing the diff alone — same best-effort
posture as the Coder side.

## Watch mode

`claw-squad index watch` keeps the index warm without a cron entry:
it runs `build` on a fixed interval (default 5 s). The sha-skip in
`build` makes a no-op pass cost ~one stat per tracked file (a few ms
even on a 50k-file monorepo), so steady-state CPU is negligible.
Mirror of `cs index watch` — same interval semantics, same retry
behaviour on a transient embedding-endpoint failure (Ollama restart,
network blip).

```bash
claw-squad index watch                           # poll every 5s in foreground
claw-squad index watch --interval 30             # slower for large monorepos
claw-squad index watch --root /repos/work        # watch a different tree
```

Operational notes:

- A transient `EmbeddingError` on one pass gets logged + the loop
  continues. Watching never aborts on a single failed pass.
- Non-Embedding errors (storage layer / refactor bugs) surface
  rather than being silently swallowed — operators notice instead
  of looping forever.
- Ctrl-C stops cleanly with a `watch stopped` line.

## Cross-tool sharing (`claw-squad` ↔ `cs`)

`claw-squad index export --out PATH` dumps the JSONL store to a
shared format that `cs index import` reads. Symmetric in reverse:
`cs index export → claw-squad index import`. Both sides agree on
`{relPath, sha256, embedding}` per line, sorted by path, embedding
values preserved exactly.

```bash
# claw-squad → cs:
claw-squad index build
claw-squad index export --out shared.jsonl
cs index import shared.jsonl

# cs → claw-squad:
cs index export --out shared.jsonl
claw-squad index import shared.jsonl
```

Malformed JSONL lines (truncated transfer, hand-edits) are skipped
+ counted; one bad line never aborts the import.

## What's next

- **Auto-shared storage** — both tools watch a common JSONL
  sidecar so a single `claw-squad index watch` keeps `cs` warm too,
  no manual export step.
