# `cs dataset export` — fine-tuning data from your run logs

`cs dataset export` walks `.claudestruct/runs/*.jsonl` and produces a
training-ready JSONL the GX10 can feed straight into axolotl / unsloth /
TRL. Pairs with `scripts/finetune-reviewer.sh` to ship a LoRA adapter
that codifies your team's review style — closer to a senior engineer
than a generic Sonnet review.

## Prereq: turn on prompt logging

Run logs **don't** capture prompts and responses by default — the JSONL
is observability data, not training data. Flip the gate before the runs
you want to mine:

```bash
export CLAUDESTRUCT_LOG_PROMPTS=1
cs review "look at the diff" path/to/files
# … each `cs review` from now on emits a `run.io` event with the prompt
# + response captured ALONGSIDE the existing observability stream.
```

Privacy default-off because raw prompts often contain proprietary code
and credentials. The W5.3 PII redactor still runs over every event, but
review your use case before flipping the switch on a shared host.

## Export

```bash
cs dataset export \
    --out reviewer-dataset.jsonl \
    --root . \
    --task review \
    --since 2026-01-01 \
    --format chat
# wrote 412 row(s) to reviewer-dataset.jsonl
```

Flags:

| Flag        | Default | Meaning                                                                |
|-------------|---------|------------------------------------------------------------------------|
| `--out`     | required| Where to write the JSONL.                                              |
| `--root`    | cwd     | Repo whose `.claudestruct/runs/` feeds the export.                     |
| `--task`    | all     | Filter to `dev` / `review` / `plan` / `debug`.                         |
| `--since`   | none    | `YYYY-MM-DD` or full ISO 8601; events older than this are skipped.     |
| `--format`  | alpaca  | `alpaca` = `{instruction, input, output}`; `chat` = `{messages: [...]}`.|

`alpaca` is the native shape for axolotl + unsloth examples; `chat` is
the better fit for chat-tuned bases (Qwen-Instruct, Llama-3-Instruct).

## Train

```bash
./scripts/finetune-reviewer.sh
# 1. exports the last 90 days of `cs review` runs (chat format)
# 2. drops a default axolotl YAML targeting Qwen2.5-Coder-7B on QLoRA
# 3. invokes `axolotl train …`; LoRA lands under .claudestruct/finetune/
```

Override the defaults via env vars:

```bash
SINCE=2025-09-01 \
OUT_DIR=/data/review-finetune \
./scripts/finetune-reviewer.sh
```

The script prints a clear warning if you have fewer than 50 training
rows — adapters need hundreds of rows minimum to learn anything your
base model doesn't already know.

## Serve the LoRA

After training, point `claudestruct` at your fine-tuned model the same
way W10.1 / W10.3 documents:

```bash
# Ollama serving the merged Qwen + LoRA:
ollama create reviewer-team -f Modelfile
ollama serve

# Tell claudestruct to use it:
export CLAUDESTRUCT_PROVIDER=openai
export CLAUDESTRUCT_BASE_URL=http://localhost:11434/v1
export CLAUDESTRUCT_MODEL_DEFAULT=reviewer-team
cs review "look at this diff"  # now uses your local fine-tune
```

## Verifying the dataset

Quick sanity check before training:

```bash
# Row count.
wc -l reviewer-dataset.jsonl

# Average response length (you want ≥ 50 tokens; otherwise the LoRA
# learns to be terse instead of insightful).
jq -r '.messages[2].content // .output' reviewer-dataset.jsonl | awk '{n+=NF} END {print n/NR}'

# Distinct task tags (alpaca format only):
jq -r '.instruction' reviewer-dataset.jsonl | sort -u
```

## What the exporter doesn't do

- **Train models.** `cs dataset export` is data-prep only; the actual
  training is up to axolotl / unsloth / TRL. The shell script is a
  reference invocation; treat it as a starting point.
- **Filter on review verdict.** Today every captured `cs review` row
  ships in the dataset. If you only want runs where the reviewer said
  "ship it", post-filter the JSONL with `jq` for now — verdict-aware
  filtering is a follow-up.
- **Mine claw-squad logs.** TypeScript-side dataset export is tracked
  separately; this PR ships only the Python surface.
