"""GitHub App webhook receiver (W6.6).

Accepts ``POST /v1/github/webhook`` with the standard GitHub App
signature header (``X-Hub-Signature-256``), verifies HMAC against the
per-installation secret, and enqueues a `Run` row when the event
matches the trigger set:

  - ``pull_request.opened``
  - ``pull_request.synchronize``
  - ``pull_request.reopened``
  - ``issue_comment.created`` whose body contains ``/cs review``

Auth model: this endpoint is intentionally NOT behind the bearer-token
auth dep because GitHub itself is the caller. Signature verification
is the only gate. Misconfigured installs (unknown `installation.id`,
bad signature, revoked install) return 401/404 so an attacker can't
distinguish "wrong secret" from "no install".

Attribution: webhook-driven runs are written under the installation's
`bot_user_id` so the team dashboard's leaderboard surfaces them as
``github-bot@<org-slug>`` instead of mis-attributing to a real user.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import logging
import secrets
from typing import Any

from fastapi import APIRouter, Header, HTTPException, Request, status
from sqlalchemy import select

from claudestruct.server.models import GitHubInstallation, Run, RunStatus

router = APIRouter(prefix="/v1/github", tags=["github"])
log = logging.getLogger("claudestruct.server.github")


# ---------------------------------------------------------------------
# Trigger detection
# ---------------------------------------------------------------------


_PR_TRIGGER_ACTIONS = {"opened", "synchronize", "reopened"}
_REVIEW_COMMAND = "/cs review"


def detect_trigger(event: str, payload: dict[str, Any]) -> dict[str, Any] | None:
    """Decide whether this event should enqueue a run.

    Returns a dict with `task`, `description`, `repo_full_name`, and
    `pr_number` when matched; ``None`` otherwise. Logic is pure so
    tests can drive the matcher without crafting full HTTP requests.
    """
    if event == "pull_request":
        action = payload.get("action")
        if action not in _PR_TRIGGER_ACTIONS:
            return None
        pr = payload.get("pull_request") or {}
        repo = (payload.get("repository") or {}).get("full_name")
        if not repo:
            return None
        title = pr.get("title") or "(no title)"
        body = pr.get("body") or ""
        return {
            "task": "review",
            "description": (
                f"Review PR #{pr.get('number', '?')} in {repo}: {title}\n\n"
                f"{body[:1500]}"  # cap so a 100k PR description doesn't blow context
            ).strip(),
            "repo_full_name": repo,
            "pr_number": pr.get("number"),
            "trigger": f"pull_request.{action}",
        }

    if event == "issue_comment":
        if payload.get("action") != "created":
            return None
        comment = payload.get("comment") or {}
        comment_body = comment.get("body") or ""
        if _REVIEW_COMMAND not in comment_body.lower():
            return None
        issue = payload.get("issue") or {}
        # Only PR comments matter; plain issues don't have diffs.
        if "pull_request" not in issue:
            return None
        repo = (payload.get("repository") or {}).get("full_name")
        if not repo:
            return None
        return {
            "task": "review",
            "description": (
                f"Review PR #{issue.get('number', '?')} in {repo} (triggered by "
                f"`/cs review` comment from "
                f"@{(comment.get('user') or {}).get('login', '?')})"
            ).strip(),
            "repo_full_name": repo,
            "pr_number": issue.get("number"),
            "trigger": "issue_comment.cs-review",
        }

    return None


# ---------------------------------------------------------------------
# Signature verification
# ---------------------------------------------------------------------


def verify_signature(secret: str, body: bytes, header_value: str | None) -> bool:
    """Constant-time HMAC-SHA256 check matching GitHub's
    `X-Hub-Signature-256: sha256=<hex>` header format. Returns True
    only on exact match; rejects empty / malformed headers."""
    if not header_value or not header_value.startswith("sha256="):
        return False
    expected = hmac.new(
        secret.encode("utf-8"), body, hashlib.sha256
    ).hexdigest()
    return hmac.compare_digest(expected, header_value[len("sha256=") :])


# ---------------------------------------------------------------------
# Endpoint
# ---------------------------------------------------------------------


@router.post(
    "/webhook",
    status_code=status.HTTP_202_ACCEPTED,
)
async def receive_webhook(
    request: Request,
    x_github_event: str | None = Header(default=None, alias="X-GitHub-Event"),
    x_hub_signature_256: str | None = Header(
        default=None, alias="X-Hub-Signature-256",
    ),
) -> dict[str, Any]:
    """Receive a GitHub App webhook event.

    Order of operations:

    1. Read raw body so the HMAC matches GitHub's bytes exactly
       (any reformatting via Pydantic would break verification).
    2. Parse JSON to extract `installation.id`.
    3. Look up the installation row; reject unknown / revoked.
    4. Verify HMAC.
    5. Run trigger detection; if it matches, write a queued Run row
       attributed to the installation's bot user.

    Returns a small JSON body even for ignored events so a curious
    operator can sanity-check via `gh api -X POST ...` against a
    local daemon.
    """
    raw = await request.body()
    try:
        payload = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise HTTPException(status_code=400, detail=f"invalid JSON body: {exc}") from exc
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="webhook body must be a JSON object")

    install_id = (payload.get("installation") or {}).get("id")
    if not isinstance(install_id, int):
        # Some events (e.g. ping) do include installation; some don't.
        # Without it we can't route to an org safely.
        raise HTTPException(
            status_code=400, detail="payload missing installation.id"
        )

    factory = request.app.state.session_factory
    with factory() as session:
        install: GitHubInstallation | None = session.execute(
            select(GitHubInstallation).where(
                GitHubInstallation.installation_id == install_id
            )
        ).scalar_one_or_none()
        if install is None or not install.is_active():
            # 401 (not 404) so we look the same to "wrong secret":
            # an attacker who guesses an install_id but doesn't have
            # the secret should not be able to enumerate which IDs
            # exist in our DB.
            raise HTTPException(status_code=401, detail="invalid installation or signature")

        if not verify_signature(install.webhook_secret, raw, x_hub_signature_256):
            raise HTTPException(status_code=401, detail="invalid installation or signature")

        # Ping events: respond OK without enqueuing.
        if x_github_event == "ping":
            return {"status": "ok", "event": "ping"}

        decision = detect_trigger(x_github_event or "", payload)
        if decision is None:
            return {
                "status": "ignored",
                "event": x_github_event,
                "reason": "no trigger match",
            }

        # Optional repo filter: substring match (case-insensitive) on
        # owner/name. Empty filter = match all.
        repo = decision["repo_full_name"]
        if install.repo_filter and install.repo_filter.lower() not in repo.lower():
            return {
                "status": "ignored",
                "event": x_github_event,
                "reason": f"repo {repo!r} does not match installation filter",
            }

        run_id = f"run-{secrets.token_hex(8)}"
        row = Run(
            run_id=run_id,
            org_id=install.org_id,
            user_id=install.bot_user_id,
            status=RunStatus.queued.value,
            task=decision["task"],
            description=decision["description"],
            paths_json=None,
        )
        session.add(row)
        session.commit()
        log.info(
            "github webhook enqueued run %s for org=%s repo=%s trigger=%s",
            run_id, install.org_id, repo, decision["trigger"],
        )

    return {
        "status": "queued",
        "run_id": run_id,
        "trigger": decision["trigger"],
        "repo": repo,
    }
