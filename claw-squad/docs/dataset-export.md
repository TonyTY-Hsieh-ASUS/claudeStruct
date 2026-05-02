# `claw-squad dataset export` — fine-tuning data from your run logs

Mirror of `cs dataset export` (W10.6) on the orchestrator side.
Walks `.claw-squad/runs/*.jsonl` and produces a training-ready JSONL
the GX10 can feed straight into axolotl / unsloth / TRL. Combine with
the Python-side export to mine both tools' run logs into a single
fine-tune corpus.

## Prereq: turn on prompt logging

Run logs **don't** capture prompts and responses by default — the
JSONL stream is observability data, not training data. Flip the gate
before the runs you want to mine:

```bash
export CLAW_SQUAD_LOG_PROMPTS=1
node dist/cli.js run "your requirement"
# every agent call from now on emits a `run-io` event with the prompt
# + response captured alongside the existing usage / phase events.
```

Privacy default-off because raw prompts often contain proprietary
code and credentials. Existing run-log redactors (when configured)
still apply; review your use case before flipping the switch on a
shared host.

## Export

```bash
node dist/cli.js dataset export \
    --out reviewer-dataset.jsonl \
    --root . \
    --role reviewer \
    --since 2026-01-01 \
    --format chat
# wrote 287 row(s) to reviewer-dataset.jsonl
```

Flags:

| Flag        | Default | Meaning                                                                |
|-------------|---------|------------------------------------------------------------------------|
| `--out`     | required| Where to write the JSONL.                                              |
| `--root`    | cwd     | Repo whose `.claw-squad/runs/` feeds the export.                       |
| `--role`    | all     | `planner` / `coder` / `reviewer` / `subagent`.                         |
| `--since`   | none    | `YYYY-MM-DD` or full ISO 8601 (events older than this are skipped).    |
| `--format`  | alpaca  | `alpaca` = `{instruction, input, output}`; `chat` = `{messages: [...]}`.|

`alpaca` is the native shape for axolotl + unsloth examples; `chat`
is the better fit for chat-tuned bases (Qwen-Coder-Instruct,
Llama-3-Instruct).

## Combine both tools' corpora

```bash
# Python side:
CLAUDESTRUCT_LOG_PROMPTS=1 cs review "..."   # capture
cs dataset export --out cs.jsonl --task review --format chat

# claw-squad side:
CLAW_SQUAD_LOG_PROMPTS=1 node dist/cli.js run "..."
node dist/cli.js dataset export --out clawsquad.jsonl --role reviewer --format chat

# Combine:
cat cs.jsonl clawsquad.jsonl > review-corpus.jsonl

# Train (see scripts/finetune-reviewer.sh from the Python side for
# a working axolotl invocation; the YAML it generates accepts any
# chat-format JSONL).
```

## What this exporter doesn't do

- **Filter on review verdict.** Today every captured run-io ships in
  the dataset. Post-filter the JSONL with `jq` if you only want runs
  whose verdict was "ship it" — verdict-aware filtering is a
  follow-up.
- **Train models.** This is data-prep only; the actual training is
  axolotl / unsloth / TRL. `scripts/finetune-reviewer.sh` (Python
  side) is a reference invocation.

## Implementation note

The Planner / Coder / Reviewer agents accept an optional `runLog`
field on their input. The orchestrator threads its existing run-log
handle through, and the agents call `emitRunIoIfEnabled()` after each
`provider.invoke()`. The env-var gate (`CLAW_SQUAD_LOG_PROMPTS`) lives
in `runs/dataset.ts#runIoEnabled` so the call site is a one-liner.

This means: **no orchestrator code changes are needed to enable IO
capture** — flip the env var and rerun. The capture is opt-in by
default for privacy.
