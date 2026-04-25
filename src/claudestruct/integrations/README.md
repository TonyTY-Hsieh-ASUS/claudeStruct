# claudestruct integrations

Drop-in templates for wiring `cs` into your existing developer workflows.

## `pre-commit-cs-review.sh`

A Bash hook that runs `cs review` on the staged diff before every commit.

```bash
cp src/claudestruct/integrations/pre-commit-cs-review.sh .git/hooks/pre-commit
chmod +x .git/hooks/pre-commit
```

Or via [pre-commit.com](https://pre-commit.com/) — see the comment block at the top of the script for the YAML stanza.

Environment knobs:
- `ANTHROPIC_API_KEY` — required; hook skips silently when unset (so CI environments don't fail).
- `CS_HOOK=0` — full bypass for emergency commits.
- `CS_HOOK_MAX_BYTES` — diff-size cap (default 600 KB). Larger diffs skip the hook to avoid stalling on a refactor.
- `CS_HOOK_BLOCK=0` — downgrade critical findings to a warning instead of blocking the commit.

## `github-action-cs-review.yml`

A GitHub Actions workflow that runs `cs review` on every pull request and posts the verdict as a PR comment.

```bash
mkdir -p .github/workflows
cp src/claudestruct/integrations/github-action-cs-review.yml .github/workflows/cs-review.yml
```

Then set the repository secret `ANTHROPIC_API_KEY` (Settings → Secrets and variables → Actions). The workflow:

- Triggers on PRs against `main` / `master` / `claude/**`. Edit the `branches` list to match your conventions.
- Skips draft PRs (`if: !github.event.pull_request.draft`).
- Passes `--max-bytes 200000` (the review-task default) so a runaway diff doesn't blow the spend cap.
- Posts the review verdict as a collapsed `<details>` block on the PR.

The workflow does NOT block the merge — it's advisory. Treat it like an extra reviewer: read the comment, decide if the finding warrants a change.
