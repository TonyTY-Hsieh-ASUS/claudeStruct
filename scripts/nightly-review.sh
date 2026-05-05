#!/usr/bin/env bash
# Nightly code-health watchdog (W10.8).
#
# Runs `cs review` against each of the last N commits on a target branch
# and drops the structured run logs under .claudestruct/runs/ so the
# morning `cs dashboard` view shows the week's quality drift.
#
# Designed to be triggered by the systemd timer at
# deploy/systemd/claudestruct-nightly.timer, but works fine from cron
# too. Pure config: zero changes to any application code.
#
# Configuration (env vars; sensible defaults):
#   CS_NIGHTLY_REPO       repo path (required, no default)
#   CS_NIGHTLY_BRANCH     branch to walk (default: main)
#   CS_NIGHTLY_DEPTH      number of recent commits to review (default: 3)
#   CS_NIGHTLY_LOG_DIR    where to write per-run JSONL logs
#                         (default: $CS_NIGHTLY_REPO/.claudestruct/runs)
#   ANTHROPIC_API_KEY     required by cs review
#
# Exits non-zero only on configuration errors. Per-commit failures are
# logged to stderr and the script keeps walking — one bad commit (e.g.
# huge merge with no diff context) shouldn't abort the whole nightly.
set -u
set -o pipefail

repo="${CS_NIGHTLY_REPO:-}"
branch="${CS_NIGHTLY_BRANCH:-main}"
depth="${CS_NIGHTLY_DEPTH:-3}"

if [[ -z "$repo" ]]; then
    echo "nightly-review: CS_NIGHTLY_REPO is required" >&2
    exit 2
fi
if [[ ! -d "$repo/.git" ]]; then
    echo "nightly-review: $repo is not a git repository" >&2
    exit 2
fi
if ! command -v cs >/dev/null 2>&1; then
    echo "nightly-review: cs binary not found on PATH" >&2
    exit 2
fi

log_dir="${CS_NIGHTLY_LOG_DIR:-$repo/.claudestruct/runs}"
mkdir -p "$log_dir"

cd "$repo"

# Fetch quietly so the branch tip is up to date. Failure to fetch is
# non-fatal — running against the last-known tip is still useful.
git fetch --quiet origin "$branch" 2>/dev/null || true

# Resolve commit SHAs once so a concurrent push doesn't drift the loop.
mapfile -t shas < <(git rev-list --max-count="$depth" "origin/$branch" 2>/dev/null \
    || git rev-list --max-count="$depth" "$branch")

if [[ ${#shas[@]} -eq 0 ]]; then
    echo "nightly-review: no commits found on $branch (depth=$depth)" >&2
    exit 0
fi

ts="$(date -u +%Y%m%dT%H%M%SZ)"
echo "nightly-review: $ts walking ${#shas[@]} commit(s) on $branch"

for sha in "${shas[@]}"; do
    short="${sha:0:12}"
    log_path="$log_dir/nightly-$ts-$short.jsonl"
    title="$(git log -1 --pretty=format:%s "$sha" | head -c 80)"

    echo "  reviewing $short — $title"

    # `cs review` walks the staged + unstaged diff by default; we want a
    # single-commit diff, so check it out into a detached HEAD just for
    # this iteration. The repo state is restored at the end of the loop.
    if ! git checkout --detach --quiet "$sha"; then
        echo "    skip $short: checkout failed" >&2
        continue
    fi

    # Diff against the parent so review sees only this commit's change.
    parent="$(git rev-parse "$sha^" 2>/dev/null || echo "")"
    if [[ -n "$parent" ]]; then
        # Reset --soft moves HEAD but keeps the working tree, so `cs
        # review` sees the parent→commit diff in its standard "current
        # branch diff" gathering path.
        git reset --soft --quiet "$parent"
    fi

    description="Nightly review of $short: $title"
    if ! cs review "$description" \
        --root "$repo" \
        --log-json "$log_path" \
        --redact 2>>"$log_dir/nightly-$ts.err"; then
        echo "    cs review failed for $short (see $log_dir/nightly-$ts.err)" >&2
    fi

    # Restore so the next iteration starts from a clean HEAD.
    git reset --hard --quiet "$sha"
done

# Leave the repo on the branch tip we started against so a later
# cs dashboard / git status doesn't surprise the operator.
git checkout --quiet "$branch" 2>/dev/null || true

echo "nightly-review: done; logs under $log_dir/nightly-$ts-*.jsonl"
