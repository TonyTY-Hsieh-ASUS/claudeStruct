---
description: Run claudestruct review — structured code review on current branch diff
argument-hint: [optional: specific review focus or files]
allowed-tools: Bash(cs review:*), Bash(claudestruct review:*)
---

Run `cs review "$ARGUMENTS"` to review the current branch's diff against main.
Prompt is cached (~10% cost on repeat calls within 1h) and uses effort=high.

Output is structured into Summary, Findings grouped by severity, and Coverage gaps.
