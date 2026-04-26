# Skills

Skills are reusable bits of guidance the Coder loads on top of its base system prompt for specific tasks. They live as Markdown files with YAML frontmatter under `.claw-squad/skills/`.

## Why skills go in the user turn, not the system prompt

The system prompt is `cache_control: ephemeral` (1h TTL). Putting per-task skill content in the system prompt would invalidate the cache on every TODO with a different skill set. Skills therefore land in the *user* message — the prompt cache for `coder.md` keeps hitting; only the trailing user content varies.

Cost: an extra few hundred tokens per Coder call, vs. losing the entire ~10k-token cache discount. Trade-off is heavily in favor of user-turn placement.

## Skill file format

```markdown
---
name: python-testing
description: Pytest patterns and fixture conventions for this repo
apply_to:
  - "tests/**/*.py"
  - "src/**/test_*.py"
---

When writing pytest cases:
- Prefer `tmp_path` over manual temp dirs.
- ...
```

- `name` — referenced by Planner when it tags a TODO with `skills: [python-testing]`.
- `description` — shown in the catalog the Planner sees so it can pick.
- `apply_to` — optional glob list. When set, the orchestrator auto-activates the skill for any task whose Coder context matches.

## Two activation paths

1. **Planner-tagged.** Planner emits `skills: ["python-testing"]` in its TODO JSON. Orchestrator loads the named skill and prepends it to the Coder's user message.
2. **Auto-activation by `apply_to`.** Orchestrator scans the Coder's context-gather files; any skill whose `apply_to` glob matches gets activated for that task too. Helps the Planner stay terse — it doesn't need to know every convention if the file paths give it away.

Both paths run during `loadActiveSkills` in `src/skills.ts`. Activated skill names are surfaced via `ui.setActiveSkills?.(names)` so TUI / Slack / Web UI can show which skills landed in a given task.

## Authoring tips

- Keep skill bodies tight (under ~50 lines). Long skills bloat every Coder call.
- Don't restate things that are already in `prompts/coder.md`. Skills are for *specific* conventions; the system prompt covers the universal Coder contract.
- Use `apply_to` for path-based skills (e.g. "Python testing", "React components"). Use Planner-tagged for task-shape skills (e.g. "API migration", "bug fix workflow").

## Testing a skill

```bash
# Drop the file under .claw-squad/skills/, then dry-run:
node dist/cli.js run "<requirement>" --dry-run
```

The dry-run report shows the activated skills per TODO. Iterate on description / glob until Planner picks the right ones, then drop `--dry-run` to execute.
