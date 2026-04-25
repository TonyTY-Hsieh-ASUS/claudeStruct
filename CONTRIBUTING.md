# Contributing

Thanks for your interest in contributing to claudeStruct. This document covers
the loop you can expect when sending a PR.

## Project layout

The repo holds three binaries that share conventions but build independently:

- `src/claudestruct/` — Python CLI (`cs`).
- `claw-squad/` — TypeScript orchestrator (`claw-squad`).
- `claw-sandbox/` — Go sandbox wrapper.

See [`CLAUDE.md`](CLAUDE.md) for the cross-cutting conventions (prompt caching
discipline, structured logging schema, configuration files).

## Development setup

```bash
# Python
pip install -e .
pytest

# TypeScript
cd claw-squad
pnpm install        # or: npm install
pnpm test
pnpm exec tsc --noEmit

# Go
cd claw-sandbox
go test ./...
```

## Branch and commit conventions

- Branch off `main`. Use a short, descriptive branch name.
- Commit messages follow [Conventional Commits 1.0](https://www.conventionalcommits.org/en/v1.0.0/):
  `feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`. The release
  automation (Wave 4.3) reads these to drive version bumps.
- Keep commits focused — one logical change per commit. Squash WIP locally
  before opening the PR.

## Pull request expectations

Before requesting review:

- [ ] CI passes (Python pytest + TypeScript vitest + Go test + type-check).
- [ ] Touched code paths have tests. New behavior gets a new test; bug fixes
      get a regression test.
- [ ] User-visible changes have a `CHANGELOG.md` entry under `[Unreleased]`.
- [ ] No secrets in diffs (`.env`, API keys, tokens).
- [ ] Prompt-cache discipline preserved: anything that varies per call lives
      in the user turn, not the system prompt (see `CLAUDE.md`).

Open the PR as **draft** while you iterate; mark ready when CI is green.

## Reporting bugs

File issues against
[github.com/tonyandclaw/claudeStruct/issues](https://github.com/tonyandclaw/claudeStruct/issues)
with reproduction steps, expected vs actual behavior, and environment details
(OS, Python/Node/Go versions, claudeStruct version). Redact any API keys before
pasting logs.

For security-sensitive reports, follow [`SECURITY.md`](SECURITY.md) instead of
filing a public issue.

## Code of conduct

Participation is governed by [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md). Be
kind. Critique code, not people.
