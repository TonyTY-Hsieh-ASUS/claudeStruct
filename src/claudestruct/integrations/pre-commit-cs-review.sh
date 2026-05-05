#!/usr/bin/env bash
#
# Pre-commit hook that runs `cs review` on the staged diff.
#
# Install:
#   cp src/claudestruct/integrations/pre-commit-cs-review.sh .git/hooks/pre-commit
#   chmod +x .git/hooks/pre-commit
#
# Or wire it through pre-commit.com:
#   - repo: local
#     hooks:
#       - id: cs-review
#         name: cs review
#         entry: src/claudestruct/integrations/pre-commit-cs-review.sh
#         language: script
#         pass_filenames: false
#         stages: [pre-commit]
#
# Behavior
#   - Skips silently when the staged diff is large (default cap 600 KB
#     to avoid stalling on a refactor; override via CS_HOOK_MAX_BYTES).
#   - Skips when ANTHROPIC_API_KEY is unset (CI environments without it
#     shouldn't fail commits).
#   - Skips when CS_HOOK=0 (escape hatch for emergency commits).
#   - Exit 0 if the review surfaced no critical findings.
#   - Exit 1 if `cs` printed the literal word "critical" (claudestruct's
#     review prompt asks for `Severity: critical | high | ...`); the
#     committer can re-run after triaging or set CS_HOOK_BLOCK=0 to
#     downgrade to a warning.

set -euo pipefail

if [[ "${CS_HOOK:-1}" == "0" ]]; then
    exit 0
fi
if [[ -z "${ANTHROPIC_API_KEY:-}" ]]; then
    echo "[cs-review] ANTHROPIC_API_KEY not set; skipping." >&2
    exit 0
fi
if ! command -v cs >/dev/null 2>&1; then
    echo "[cs-review] 'cs' not on PATH; skipping. Install with 'pip install -e .'" >&2
    exit 0
fi

MAX_BYTES="${CS_HOOK_MAX_BYTES:-600000}"
STAGED_BYTES=$(git diff --cached --numstat | awk '{s+=$1+$2} END {print s*80}')
if [[ -n "$STAGED_BYTES" && "$STAGED_BYTES" -gt "$MAX_BYTES" ]]; then
    echo "[cs-review] staged diff ~${STAGED_BYTES} bytes > cap ${MAX_BYTES}; skipping." >&2
    exit 0
fi

OUTPUT="$(cs review --max-bytes "$MAX_BYTES" 2>&1 || true)"
echo "$OUTPUT"

if echo "$OUTPUT" | grep -qE 'severity:[[:space:]]*critical'; then
    if [[ "${CS_HOOK_BLOCK:-1}" == "1" ]]; then
        echo "[cs-review] critical finding detected — blocking commit (set CS_HOOK_BLOCK=0 to downgrade to warning)." >&2
        exit 1
    fi
    echo "[cs-review] critical finding detected (warning only; CS_HOOK_BLOCK=0)." >&2
fi

exit 0
