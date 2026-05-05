# claw-squad

The TypeScript orchestrator. Three agents (Planner → Coder → Reviewer), one
runner, eight provider backends. See:

- [Agents](claw-squad/agents.md) — orchestrator state machine, agent contract,
  adding a new role.
- [Skills](claw-squad/skills.md) — skill loading and `apply_to` matching.
- [Hooks](claw-squad/hooks.md) — lifecycle hooks
  (`preAgent`/`postAgent`/`preCommit`/`postCommit`/`onBudgetExceeded`).
- [Providers](claw-squad/providers.md) — adding a new model backend.

## Quick start

```bash
cd claw-squad
pnpm install
pnpm build
node dist/cli.js run "your requirement"
```

## Configuration

`.claw-squad/config.json` is validated by zod (`src/config-schema.ts`) before
agents start. Typos fail fast with a `agents.planner.effort` style path. See
the schema source for the full shape.

## State and resume

State persists in `.claw-squad/state.json` after every outer loop and in the
orchestrator's `finally` block. SIGINT routes through the same path so
Ctrl-C doesn't lose progress. Pass `--resume` to pick up where you left off.

## Run logs

Every run writes `.claw-squad/runs/<iso-timestamp>.jsonl` (append-only,
crash-safe). The `claw-squad dashboard` subcommand folds these into a
human-readable table or `--json` output, with `--watch` for live tail and
`dashboard diff <a> <b>` for regression analysis.
