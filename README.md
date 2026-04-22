# claudestruct

**Token-efficient Claude companion for Claude Code workflows.**

`cs` is a CLI tool that makes Claude Code sessions cheaper and more focused on
four common workflows:

- `cs dev <desc>` — propose a minimal code change
- `cs review [files]` — structured code review of the current branch diff
- `cs plan <desc>` — architecture / implementation planning
- `cs debug <error>` — hypothesis-ranked debugging (no jumping to fixes)

## Why

Every extra byte you send to the API costs tokens. Every byte that changes
between calls kills your prompt cache. `claudestruct` attacks both:

1. **Prompt caching, 1h TTL.** Each task type has a frozen system prompt
   marked with `cache_control: ephemeral`. Repeat calls within the hour cost
   ~10% of the input price for the cached portion. On a 50KB system prompt,
   that's a ~9x cost reduction per repeat call.
2. **Smart context collection.** `cs` doesn't dump your whole repo at Claude.
   It uses `git` to find recently-changed files, respects `.gitignore`, skips
   binaries, caps file and total size budgets, and returns files in a
   deterministic order (so the cache actually hits).
3. **Task-specific effort.** `dev` and `review` use `effort=high`; `plan` and
   `debug` use `effort=xhigh` because deeper reasoning pays off there.
4. **Adaptive thinking.** Claude decides when and how much to think per
   request — no hand-tuned `budget_tokens`.
5. **Streaming always on.** Avoids SDK HTTP timeouts at large `max_tokens`
   and gives you tokens live.
6. **Dry-run + token counter.** `--dry-run` or `cs tokens` let you estimate
   cost before spending.

## Install

```bash
pip install -e .
export ANTHROPIC_API_KEY=sk-ant-...
```

## Usage

```bash
# Development task — collects git-changed files
cs dev "add retry logic with exponential backoff to client.py"

# Pass explicit files instead of letting git decide
cs dev "refactor the auth middleware" src/auth.py src/middleware.py

# Code review of current branch vs origin/main
cs review

# Plan a feature — uses effort=xhigh, architecture context
cs plan "design a background job queue with idempotency guarantees"

# Debug — forces hypothesis ranking before proposing a fix
cs debug "tests pass locally but fail in CI with SIGSEGV in the parser"

# See what would be sent, without calling Claude
cs context dev
cs dev "..." --dry-run           # gather context + count tokens
cs dev "..." --show-context      # print summary of collected files

# Count tokens for a specific task + message
cs tokens dev "add logging to foo()" foo.py
```

## Flags (applies to all task commands)

| Flag | Default | Notes |
|---|---|---|
| `--root PATH` | cwd | Project root |
| `--model ID` | `claude-opus-4-7` | Any supported Claude model |
| `--max-tokens N` | 16000 | Streamed, so you can safely raise this |
| `--effort LEVEL` | per-task | `low` \| `medium` \| `high` \| `xhigh` \| `max` |
| `--dry-run` | off | Don't call Claude; show context + token count |
| `--show-context` | off | Print collected context summary and exit |
| `-v / --verbose` | off | Show skipped files and reasons |

## Claude Code integration

Slash commands are registered in `.claude/commands/`:

- `/cs-dev <desc>`
- `/cs-review [focus]`
- `/cs-plan <desc>`
- `/cs-debug <error>`

Each just shells out to the `cs` CLI so you get the same caching and context
collection whether you call it from the terminal or from inside Claude Code.

## How the caching actually works

The system prompt for each task is a fixed string. It lives in `prompts.py`
and never interpolates the date, session id, user id, or any per-request data
— those are silent cache invalidators. The only `cache_control` breakpoint
sits on the system block with a 1h TTL.

Render order in the API is `tools → system → messages`. Putting the
breakpoint on the last system block caches the entire stable prefix. The
user's task description and collected file context go in the `messages`
array, *after* the cached prefix, so they can vary freely without breaking
anything.

After the first call you should see `cache_read_input_tokens > 0` in the
usage summary. If you don't, something on your side is changing the prefix
byte-for-byte between calls (check for timestamps in a wrapper, non-deterministic
JSON serialization, or varying tool lists).

## Testing

```bash
pip install -e .
pytest tests/
```

Tests don't hit the API — they exercise context gathering only.

## Model

Default is `claude-opus-4-7` because it's the most capable model and our
workflows are intelligence-sensitive. Override with `--model claude-sonnet-4-6`
for cost-sensitive review / dev passes, or `claude-haiku-4-5` for quick
classification-style tasks.
