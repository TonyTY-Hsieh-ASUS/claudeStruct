"""Sentry error reporting — opt-in via `CLAUDESTRUCT_SENTRY_DSN`.

Activates only when the DSN env var is set. Without it, every helper
is a no-op and the `sentry-sdk` package never loads, matching the
zero-overhead pattern from `tracing.py`.

Redaction
---------
We hard-redact the following from every event before it leaves the
process via a `before_send` hook:

  - `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_API_KEY`,
    `MINIMAX_API_KEY`, `OPENAI_COMPAT_API_KEY` — the API keys this
    repo's tools speak to
  - `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `CLAW_WEB_TOKEN` —
    transport tokens for the claw-squad UIs
  - `GITHUB_TOKEN` — the only GitHub-side credential we ever touch

Redaction runs in three places per event:
  1. `extra` and `tags` dicts (top level)
  2. `request.env` (CGI-style env capture)
  3. `breadcrumbs[*].data` and `breadcrumbs[*].message`

We also strip any header named `authorization` / `x-api-key`
case-insensitively. False negatives (tokens embedded in URL paths,
filenames, etc.) aren't covered — those are caller bugs and Sentry's
event-search side has its own redaction tools for that case.

Why a separate module: pulling sentry-sdk into the import graph for
non-error runs would add ~2 MB of resident memory and a mild import
penalty. Keeping it here, with the SDK lazy-imported inside `init()`,
means the dev/review/plan/debug hot path is unchanged.
"""
from __future__ import annotations

import os
import re
import sys
from typing import Any

# Substrings (case-insensitive) that mark a key as redactable. Matched
# against env-var keys, dict keys, and breadcrumb message tokens.
_REDACT_PATTERNS = re.compile(
    r"(api[_-]?key|secret|token|password|authorization|bearer|"
    r"anthropic|openai|google|minimax|slack|github|claw_web)",
    re.IGNORECASE,
)
_REDACTED = "[redacted]"

_initialized: bool = False
_enabled: bool = False


def is_enabled() -> bool:
    return _enabled


def _redact_dict(d: Any) -> None:
    """In-place redact obviously-sensitive keys."""
    if not isinstance(d, dict):
        return
    for k, v in list(d.items()):
        if isinstance(k, str) and _REDACT_PATTERNS.search(k):
            d[k] = _REDACTED
        elif isinstance(v, dict):
            _redact_dict(v)
        elif isinstance(v, list):
            for item in v:
                _redact_dict(item)


def _scrub_event(event: dict[str, Any], _hint: dict[str, Any]) -> dict[str, Any]:
    """Sentry `before_send` hook. Mutates in place AND returns to play
    nicely with the SDK's expectations."""
    # Top-level dicts most likely to carry tokens.
    for key in ("extra", "tags", "contexts", "user"):
        _redact_dict(event.get(key))

    # Request env (when sentry-django/flask-style integrations populate it).
    request = event.get("request") or {}
    _redact_dict(request.get("env"))
    # Headers can carry Authorization / cookies.
    headers = request.get("headers")
    if isinstance(headers, dict):
        for h in list(headers.keys()):
            if h.lower() in {"authorization", "cookie", "x-api-key"}:
                headers[h] = _REDACTED
    # The SDK sometimes serialises headers as a list of [name, value] tuples.
    if isinstance(headers, list):
        for entry in headers:
            if isinstance(entry, (list, tuple)) and len(entry) == 2:
                name = entry[0]
                if isinstance(name, str) and name.lower() in {
                    "authorization", "cookie", "x-api-key",
                }:
                    entry[1] = _REDACTED

    # Breadcrumbs are how leaked tokens most often slip through —
    # any logger.info() that accidentally includes a key gets here.
    for bc in (event.get("breadcrumbs") or {}).get("values", []) or []:
        _redact_dict(bc.get("data"))
        msg = bc.get("message")
        if isinstance(msg, str):
            bc["message"] = _redact_message(msg)

    return event


# Match `<keyname>=<value>` or `<keyname>: <value>` where keyname looks
# sensitive. We capture the keyname so the result preserves it (so
# operators reading the scrubbed event still see *what* was redacted)
# and elide the value entirely.
_KV_PATTERN = re.compile(
    r"((?:[A-Za-z0-9_-]*"
    r"(?:api[_-]?key|secret|token|password|authorization|bearer|"
    r"anthropic|openai|google|minimax|slack|github|claw_web)"
    r"[A-Za-z0-9_-]*))\s*[=:]\s*[^\s,;]+",
    re.IGNORECASE,
)


def _redact_message(msg: str) -> str:
    """Strip `key=value` style token leaks from a free-form message."""
    return _KV_PATTERN.sub(lambda m: f"{m.group(1)}={_REDACTED}", msg)


def init(dsn: str | None = None, *, environment: str | None = None) -> bool:
    """Initialise Sentry if a DSN is set in env or supplied here.

    Returns True if Sentry is now active, False otherwise. Idempotent:
    a second call returns the prior result without re-initializing.
    """
    global _initialized, _enabled
    if _initialized:
        return _enabled
    _initialized = True

    resolved_dsn = dsn or os.environ.get("CLAUDESTRUCT_SENTRY_DSN", "").strip()
    if not resolved_dsn:
        _enabled = False
        return False

    try:
        import sentry_sdk  # type: ignore
    except ImportError:
        sys.stderr.write(
            "[sentry] CLAUDESTRUCT_SENTRY_DSN is set but sentry-sdk is not "
            "installed. Run `pip install claudestruct[sentry]` to enable "
            "error reporting.\n"
        )
        _enabled = False
        return False

    sentry_sdk.init(
        dsn=resolved_dsn,
        environment=environment or os.environ.get("CLAUDESTRUCT_ENV", "production"),
        release=os.environ.get("CLAUDESTRUCT_RELEASE"),
        before_send=_scrub_event,
        # Default sample rates: capture every error, no perf traces.
        # Users opt into perf via OTel (see tracing.py) instead.
        traces_sample_rate=0.0,
        send_default_pii=False,
    )
    _enabled = True
    return True


def capture_exception(exc: BaseException) -> None:
    """Send `exc` to Sentry with the configured scrubber. No-op when
    disabled. Prefer raising the exception and letting the integration
    catch it; this is for the cases where we want to report and
    swallow."""
    if not _enabled:
        return
    try:
        import sentry_sdk  # type: ignore
        sentry_sdk.capture_exception(exc)
    except Exception:
        # Reporting must never override the original failure path.
        pass
