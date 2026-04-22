---
description: Run claudestruct plan — architecture / implementation planning mode
argument-hint: <what to plan>
allowed-tools: Bash(cs plan:*), Bash(claudestruct plan:*)
---

Run `cs plan "$ARGUMENTS"` to get an implementation plan.

Uses effort=xhigh for deeper reasoning, cached system prompt, and
architecture-focused context (README, configs, top-level source).

Output: Goal, Approaches considered, Chosen approach, Implementation steps,
Files and order, Open questions.
