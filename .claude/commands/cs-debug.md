---
description: Run claudestruct debug — hypothesis-ranked debugging, not a jump to the fix
argument-hint: <error message or symptom>
allowed-tools: Bash(cs debug:*), Bash(claudestruct debug:*)
---

Run `cs debug "$ARGUMENTS"` to investigate a failure.

The workflow forces Claude to rank hypotheses and propose a diagnostic step
BEFORE suggesting a fix. Uses effort=xhigh and collects dirty/recent files
as context. Cached system prompt keeps repeat debugging cheap.
