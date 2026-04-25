# Agents

3 primary agents (Planner, Coder, Reviewer) plus optional Subagents. Each is a thin function that takes structured input and returns structured output. The orchestrator is the only thing that touches git, GitHub, the file system, or the user — agents only emit JSON-ish responses.

## Orchestrator state machine

```
                  ┌──────────────────┐
                  │  Phase 1: Q&A    │   maxClarifications cap
   requirement →  │  (Planner)       │   bounded loop
                  └────────┬─────────┘
                           │ planReady
                  ┌────────▼─────────┐
                  │  Phase 2: TODOs  │   Planner emits a list
                  │  (Planner)       │
                  └────────┬─────────┘
            dryRun? ──────▶ return reason="dry_run"
                           │
                  ┌────────▼─────────┐
                  │  Phase 3: Loop   │   per TODO:
                  │  (Coder ↔ Rev)   │     1. Coder produces edits
                  │                  │     2. Test runner (optional)
                  │                  │     3. Reviewer verdict
                  │                  │     4. on request_changes:
                  │                  │        feed back, retry up to
                  │                  │        maxReviewRounds
                  │                  │     5. on approve + githubEnabled:
                  │                  │        push, optional CI wait, merge
                  └────────┬─────────┘
                           │ all TODOs done | maxLoops | budget exceeded | abort
                  ┌────────▼─────────┐
                  │  finally:        │   saveSnapshot, run-end event,
                  │  persist state   │   self-learning memory write
                  └──────────────────┘
```

State lives in `SquadState` (see `src/types.ts`). Only the orchestrator mutates it; agents read.

## Agent contract

```ts
async function runAgent(input: AgentInput, ctx: AgentContext): Promise<AgentOutput>
```

Each agent file (`src/agents/planner.ts`, `coder.ts`, `reviewer.ts`) is the same shape:

1. **Build the user message.** Concatenate role-specific context: previous round's diff, Reviewer findings, TODO description, file context, etc.
2. **Call `provider.invoke()`** with the cached system prompt + the user message.
3. **Parse the response** into a typed structure (`PlannerOutcome`, `CoderEdits`, `ReviewerVerdict`).
4. **Return** — never apply, commit, or push. The orchestrator owns side effects.

This keeps the agents pure: each is one Claude call wrapped in a parser. Tests mock the provider and assert against parsed output.

## UI seam (UserInterface)

Plain CLI, TUI, Slack, and Web UI all implement `UserInterface` (`src/orchestrator.ts`). The orchestrator never knows which one is wired:

- `askClarifications(qs)` — Planner Q&A
- `confirm(prompt)` — destructive action gating (push, merge)
- `log(msg)` — progress line
- `streamAgent(role, chunk)` — token-by-token output
- `trackUsage?(role, delta)` — live cost header
- `onQuit?(fn)` — register a graceful-abort callback (TUI 'q', SIGINT)
- `updateState?(state)` — push state changes to the UI

The SIGINT handler in `src/abort-signal.ts` wraps any `UserInterface` so Ctrl-C goes through the same `onQuit` path as TUI quit.

## Adding a new agent role

Rare, but possible — e.g. a "Tester" agent between Coder and Reviewer:

1. Add the role to `AgentRole` (`src/types.ts`) and `ROLES` arrays.
2. Add a `prompts/<role>.md` file. Restart picks up the new prompt; `loadPromptVersion("<role>")` works automatically.
3. Add `src/agents/<role>.ts` following the contract above.
4. Wire the role into `runTaskLoop` between existing phases.
5. Extend `RoleBucket` and `RUN_BUCKETS` in `src/totals.ts` so the new role's spend is tracked separately.

`subagents` (declared in `config.json` under `subagents: [...]`) are a lighter-weight version of this — same provider config, just dispatched by Planner via `## Delegate <name>` directives. No new role bucket needed; they roll into `subagent` totals.
