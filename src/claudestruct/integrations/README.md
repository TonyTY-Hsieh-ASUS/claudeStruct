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

## `gitlab-ci-cs-review.yml`

GitLab CI equivalent of the GitHub Action above. Runs `cs review` on every
merge request and posts the verdict as an MR note via the GitLab Notes API.

```bash
cp src/claudestruct/integrations/gitlab-ci-cs-review.yml .gitlab-ci.yml
```

Set the project CI/CD variable `ANTHROPIC_API_KEY` (Settings → CI/CD →
Variables, mark **Masked** + **Protected**). The default `CI_JOB_TOKEN`
already has the project scope it needs to post notes; if your project
hardened the job-token allowlist, grant `notes:write` explicitly.

Trigger scope: merge-request pipelines (`$CI_PIPELINE_SOURCE == "merge_request_event"`).
The job runs with `allow_failure: true` so a failed `cs` invocation never
blocks the merge — the comment is the deliverable. Flip to `false` if you
want critical findings to gate.

## `bitbucket-pipelines-cs-review.yml`

Bitbucket Cloud Pipelines equivalent. Runs `cs review` on every pull
request and posts the verdict via the Bitbucket 2.0 Comments API.

```bash
cp src/claudestruct/integrations/bitbucket-pipelines-cs-review.yml bitbucket-pipelines.yml
```

Set three repository variables (Repository settings → Repository variables):

- `ANTHROPIC_API_KEY` (Secured)
- `BITBUCKET_USER` — Bitbucket username that owns the app password
- `BITBUCKET_APP_PASSWORD` (Secured) — app password with **Pull requests: write**, or a workspace access token with the same scope

Trigger scope: `pipelines.pull-requests."**"` — every open PR fires the
pipeline. The build artifact `review.md` is retained for one week so you can
inspect the raw verdict if the comment got truncated.

## Common knobs

All three CI templates share the same env-driven cost controls:

- `ANTHROPIC_API_KEY` — required.
- `CLAUDESTRUCT_MONTHLY_CAP_USD` (optional) — cumulative spend cap for the
  current UTC calendar month, aggregated across `<root>/.claudestruct/runs/*.jsonl`.
  When set, `cs` aborts before the LLM call once the cap is reached.
- `--max-bytes 200000` (hardcoded in the templates) — per-run context budget.
