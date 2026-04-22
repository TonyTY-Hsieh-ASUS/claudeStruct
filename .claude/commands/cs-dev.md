---
description: Run claudestruct dev — propose a minimal code change with cached system prompt
argument-hint: <description of the change>
allowed-tools: Bash(cs dev:*), Bash(claudestruct dev:*)
---

Run `cs dev "$ARGUMENTS"` in the current repository. This invokes the
token-efficient dev workflow:

- Cached system prompt (~10% cost on repeat calls within 1h)
- Smart context: only files that changed in git, respecting .gitignore
- Adaptive thinking + effort=high

Report the token usage summary at the end.
