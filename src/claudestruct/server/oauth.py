"""GitHub OAuth helpers (W6.4).

Pure functions over `httpx` so the route handlers stay thin and the
tests can drive them without real HTTP. Provider config is read from
env vars at request time:

  - ``CLAUDESTRUCT_GITHUB_OAUTH_CLIENT_ID``
  - ``CLAUDESTRUCT_GITHUB_OAUTH_CLIENT_SECRET``
  - ``CLAUDESTRUCT_OAUTH_REDIRECT_BASE`` (default ``http://localhost:8787``)

When the env vars aren't set the routes return 503 — we fail closed
rather than silently letting the user click a link that errors out
on GitHub's side.

Why GitHub only for now: every team that runs `cs review` already has
a GitHub identity; adding Google / Microsoft / SSO is structurally
identical (`build_<provider>_authorize_url` + `exchange_<provider>_code`
+ `fetch_<provider>_user`) and tracked under W8.7.
"""
from __future__ import annotations

import os
import secrets as _secrets
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any
from urllib.parse import urlencode

# --- Config ---------------------------------------------------------


@dataclass(frozen=True)
class GitHubOAuthConfig:
    client_id: str
    client_secret: str
    redirect_base: str

    @property
    def callback_url(self) -> str:
        # GitHub validates this against the App's "Authorization callback
        # URL" exactly — keep the path stable and don't include trailing
        # slash variations.
        return f"{self.redirect_base.rstrip('/')}/v1/auth/github/callback"


def load_github_config() -> GitHubOAuthConfig | None:
    """Load OAuth config from env. Returns None when unconfigured so
    the routes can return 503 instead of crashing on startup."""
    client_id = os.environ.get("CLAUDESTRUCT_GITHUB_OAUTH_CLIENT_ID", "").strip()
    client_secret = os.environ.get("CLAUDESTRUCT_GITHUB_OAUTH_CLIENT_SECRET", "").strip()
    redirect_base = os.environ.get(
        "CLAUDESTRUCT_OAUTH_REDIRECT_BASE", "http://localhost:8787",
    ).strip()
    if not client_id or not client_secret:
        return None
    return GitHubOAuthConfig(
        client_id=client_id,
        client_secret=client_secret,
        redirect_base=redirect_base,
    )


# --- URL builders ---------------------------------------------------


def build_authorize_url(cfg: GitHubOAuthConfig, *, state: str) -> str:
    """Where the browser is redirected to start the dance.

    Scopes: ``read:user`` is enough to fetch email + login; we don't
    request ``repo`` since the daemon never acts on the user's repos
    via the user's token (the GitHub App with its own install token
    handles that — see W6.6).
    """
    params = {
        "client_id": cfg.client_id,
        "redirect_uri": cfg.callback_url,
        "scope": "read:user user:email",
        "state": state,
        "allow_signup": "false",
    }
    return f"https://github.com/login/oauth/authorize?{urlencode(params)}"


# --- HTTP exchanges -------------------------------------------------


def exchange_code_for_token(
    cfg: GitHubOAuthConfig,
    code: str,
    *,
    http_client: Any,
) -> str:
    """Trade the OAuth code for a user access token.

    `http_client` is anything with a `.post(url, ...)` method that
    returns an object with `.status_code` and `.json()`. Production
    passes an `httpx.Client`; tests pass a stub.
    """
    response = http_client.post(
        "https://github.com/login/oauth/access_token",
        headers={"Accept": "application/json"},
        data={
            "client_id": cfg.client_id,
            "client_secret": cfg.client_secret,
            "code": code,
            "redirect_uri": cfg.callback_url,
        },
        timeout=15.0,
    )
    if response.status_code != 200:
        raise OAuthError(f"github token exchange returned {response.status_code}")
    payload = response.json()
    token = payload.get("access_token")
    if not isinstance(token, str) or not token:
        # GitHub returns 200 even on errors with an `error` field.
        err = payload.get("error_description") or payload.get("error") or "unknown"
        raise OAuthError(f"github token exchange failed: {err}")
    return token


def fetch_github_user(token: str, *, http_client: Any) -> dict[str, str]:
    """Pull the authenticated user's identity. Returns `{"login", "email", "name"}`.

    GitHub has separate `/user` and `/user/emails` endpoints because
    the email might be private. We try /user first (cheap, single
    call) and fall back to /user/emails to find a verified primary.
    """
    user_resp = http_client.get(
        "https://api.github.com/user",
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
        },
        timeout=15.0,
    )
    if user_resp.status_code != 200:
        raise OAuthError(f"github /user returned {user_resp.status_code}")
    body = user_resp.json()
    login = body.get("login") or ""
    name = body.get("name") or login
    email = body.get("email") or ""
    if not email:
        emails_resp = http_client.get(
            "https://api.github.com/user/emails",
            headers={
                "Authorization": f"Bearer {token}",
                "Accept": "application/vnd.github+json",
            },
            timeout=15.0,
        )
        if emails_resp.status_code == 200:
            for entry in emails_resp.json():
                if entry.get("primary") and entry.get("verified"):
                    email = entry.get("email") or ""
                    break
    if not login or not email:
        raise OAuthError("github user response missing login/email")
    return {"login": login, "email": email, "name": name}


# --- Session-token helpers ------------------------------------------


def new_session_token() -> str:
    """High-entropy URL-safe token for the cookie value."""
    return _secrets.token_urlsafe(32)


def new_state_token() -> str:
    """CSRF state token — round-trips through GitHub and back."""
    return _secrets.token_urlsafe(16)


SESSION_TTL = timedelta(days=14)


def session_expiry(now: datetime | None = None) -> datetime:
    return (now or datetime.now(timezone.utc)) + SESSION_TTL


# --- Errors ---------------------------------------------------------


class OAuthError(RuntimeError):
    """Raised when the OAuth provider conversation goes off-rails.

    Caught by the route handler and surfaced as a 400 with a sanitised
    message — never leak the upstream error verbatim, since some
    providers echo back fragments of the request that could include
    PII or the token itself."""
