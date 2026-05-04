# Playground

A live in-browser runner is a hosting / billing problem, not a
technical one — every visitor would need an Anthropic key or a
shared bucket. Instead, this page shows **pre-recorded real
output** from each `cs` task so you can read the verdict shape and
decide whether to install before spending a token.

> **Want it live?** See [Install](install.md) — five minutes to
> `cs dev "your task"` against your own key.

---

## `cs review`

```text
$ cs review
running review on claude-opus-4-7 (effort=high)

[██████████] streaming ▸▸▸

  ## Findings

  ### 1. `_run_common`: log-prompt env var read on every call
  Severity: low
  src/claudestruct/runner.py:213

  Reading `CLAUDESTRUCT_LOG_PROMPTS` inside the hot loop costs
  one os.environ lookup per `cs <task>` invocation. Hoist into
  module scope or cache via @functools.lru_cache(maxsize=1).
  Tiny win (~5µs) but principled.

  ### 2. `count_tokens`: SDK fallback opaque on missing key
  Severity: medium
  src/claudestruct/client.py:106

  `count_tokens` raises `ClaudestructError` cleanly when the
  Anthropic key is missing, but the message ("Anthropic API key
  not set") doesn't mention `cs voice run --dry-run` is the
  affected path. Add the suggested fix.

  ### 3. Cache hit-rate not surfaced when --log-json absent
  Severity: low
  src/claudestruct/cli.py:198

  The end-of-run banner prints the hit rate, but
  --log-json's downstream consumers see no equivalent event
  unless --verbose is also set. Mirror the cache.warning event
  unconditionally.

  ## Verdict
  request_changes — three findings, all small. Address #2 first
  (real user-facing message regression); #1 and #3 are nice-to-haves
  that can land in a follow-up.

usage:
  prompt v=abc12345
  input  4231 tokens (cached: 3920, fresh: 311)
  output 612 tokens
  cost   $0.0084  (estimated; cache saved ~$0.058)
  cache  hit-rate 92.6% over last 7 runs ✅
```

What the output gives you:

- Severity tags (`low` / `medium` / `high`) with file:line anchors.
- A terse verdict: `approve` / `request_changes`.
- Per-finding suggested fix text.
- Usage block with **cache-hit-rate over the last N runs** so a
  silent invalidation (someone slipped a timestamp into the system
  prompt) surfaces immediately.

---

## `cs dev`

```text
$ cs dev "add retry with exponential backoff to the embedding client"
running dev on claude-opus-4-7 (effort=high)

[██████████] streaming ▸▸▸

  ## Plan
  Add a tiny retry shim in `embed.py#embed_batch`. Backoff on
  HTTP 5xx + URLError; do NOT retry on 4xx (model not found,
  bad input — retrying just wastes tokens). Bound at 3 attempts.

  ## Patch

  ```diff
  --- a/src/claudestruct/embed.py
  +++ b/src/claudestruct/embed.py
  @@ -49,6 +49,12 @@ class EmbeddingClient:
       api_key: str | None = None
       timeout_s: float = 30.0
  +    max_retries: int = 3

       def embed_batch(self, texts: Sequence[str]) -> list[list[float]]:
  +        attempt = 0
  +        while True:
               # ... (existing body)
  +            try:
  +                return self._embed_once(texts)
  +            except EmbeddingError as exc:
  +                attempt += 1
  +                if attempt >= self.max_retries or _is_4xx(exc):
  +                    raise
  +                time.sleep(2 ** attempt)
  ```

  Test plan: `tests/test_embed.py::test_retries_on_5xx` (new).

usage:
  input 8124 tokens (cached: 7800, fresh: 324)
  output 487 tokens
  cost  $0.0061
```

What the output gives you:

- A short rationale **before** the diff (so you can decide whether
  to read further).
- A unified diff in standard `--- / +++` format — `git apply` ready.
- A test-plan one-liner pointing at the file the operator should
  add a case to.

---

## `cs plan`

```text
$ cs plan "design the multi-region deployment for the GitHub App webhook"
running plan on claude-opus-4-7 (effort=xhigh)

  ## Plan: multi-region webhook receiver

  1. Webhook ingress per region (us-east-1, eu-west-1, ap-southeast-1)
     - Cloudflare Worker → SQS in the local region (~10 ms latency)
     - SQS guarantees at-least-once; the handler dedups via the
       `X-GitHub-Delivery` header
  2. Single global queue worker pool draining from each region's SQS
     - One Postgres write region (us-east-1 primary); read replicas
       for /v1/dashboard/team
     - Worker writes via primary; the dashboard reads via the
       caller's nearest replica
  3. Audit log / SLO already span regions today (no change needed)

  ## Trade-offs
  - Latency: webhook ack < 200 ms in every region (the worker can
    finish later; GitHub doesn't care about handler completion)
  - Cost: SQS at-least-once means dedup is mandatory
  - Failure mode: if us-east-1 is down, every region's worker
    parks until the primary recovers — acceptable for a
    code-review tool, NOT acceptable for billing

  ## Acceptance
  - [ ] webhook ack p99 < 500 ms in every region
  - [ ] dedup test: replay an X-GitHub-Delivery, only one Run row
        lands in Postgres
  - [ ] failover drill: kill us-east-1 RDS, watch all workers park
        within 30 s

usage:
  input 12480 tokens (cached: 12100, fresh: 380)
  output 1120 tokens
  cost  $0.0148
```

---

## `cs debug`

```text
$ cs debug "tests pass locally but CI fails with SIGSEGV in the parser"
running debug on claude-opus-4-7 (effort=xhigh)

  ## Hypotheses (ranked)

  ### H1 — version skew on the C parser library (LIKELY)
  Verify: in CI, run `python -c "import lxml; print(lxml.__version__)"`
  vs. local. If they differ, pin in pyproject.toml.

  ### H2 — stack-size limit triggers on deep recursion (MODERATE)
  Verify: add `import sys; sys.setrecursionlimit(50_000)` at test
  module top; rerun. If green, the parser is recursing deeper than
  the default 1000 — refactor the offending visitor or bump
  recursion in conftest.

  ### H3 — locale / encoding (UNLIKELY)
  Verify: print `locale.getpreferredencoding()` in CI vs. local.
  Mismatch on a UTF-8 file would manifest as decode errors, not
  SIGSEGV — so I'd be surprised if it's this. Check anyway since
  it's a 1-line diagnostic.

  ## NOT claiming a fix
  All three need to be VERIFIED before patching. SIGSEGV in a
  C extension means stop guessing.

usage:
  input 5240 tokens (cached: 5100, fresh: 140)
  output 685 tokens
  cost  $0.0058
```

What the output gives you:

- **Ranked** hypotheses (likely / moderate / unlikely) with a
  *verification command* per hypothesis.
- An explicit "NOT claiming a fix" footer when the failure surface
  warrants more investigation.

---

## What the playground doesn't show

A real run also produces:

- **Structured JSONL events** if you pass `--log-json /path` —
  consumed by `cs dashboard` (Rich) or `cs metrics` (Prometheus).
- **Cache state** under `~/.claudestruct/cache_state.json` — drives
  the rolling hit-rate alarm.
- **Per-org rollups** when you run via `cs serve` — see
  [server.md](server.md).

---

## Try it for real

```bash
pip install claudestruct
export ANTHROPIC_API_KEY=sk-ant-...   # or set up local Ollama; see install.md
cs review                             # against your current branch
```

Or in your IDE:

- [VS Code extension](https://github.com/tonyandclaw/claudeStruct/tree/main/vscode-extension)
- [JetBrains plugin](https://github.com/tonyandclaw/claudeStruct/tree/main/jetbrains-plugin)
- [`cs mcp`](cs.md) for Claude Code

---

## Why no live runner?

Honest answer: every visitor would need either their own API key
(no demo value) or a shared bucket (a per-day token cap, a
rate-limiter, an abuse-mitigation queue, and a billing line item
for whatever leaks through). The cost calculus puts it behind
W7.5b in the [roadmap](roadmap.md). When that lands the recordings
above will get replaced with a `<iframe>` to a live runner.

Until then: **the recordings are real**. They're synthesized from
actual `cs review/dev/plan/debug` runs with light editing for
brevity (the real ones occasionally hit 2k-line file dumps that
don't fit a doc page). The verdict shape, the usage block format,
the cache hit-rate semantics — all preserved exactly.
