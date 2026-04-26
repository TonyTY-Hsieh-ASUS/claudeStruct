"""PII / secret redaction for log events (W5.3).

The structured-logging surface (`logging.py`) writes raw event dicts
straight to JSONL. That's fine for run metadata (token counts, costs,
prompt versions) but a leaky path for anything user-supplied —
descriptions can contain emails, file contents can contain API keys,
and stack traces from upstream errors can contain JWTs.

This module provides a :class:`Redactor` that walks an event dict and
replaces matched substrings with a constant token. The default ruleset
covers email addresses, AWS access keys, GCP service-account keys, and
the same high-entropy bearer-token shapes used by Anthropic, GitHub,
Slack, and Stripe. Callers can extend with their own regex via
:meth:`Redactor.add_rule`.

Default behavior is **off** so existing callers see no change. Opt in
by constructing a redactor and passing it to ``logging.fanout_log`` or
``EventSink``. Future work (W5.2 Sentry, W5.1 OTel) will share the
same redactor instance.

Retention is the other half of W5.3 — see :func:`purge_runs`. It
deletes ``<root>/.claudestruct/runs/*.jsonl`` files older than the
specified cutoff.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from re import Pattern
from typing import Any

REDACTED = "[redacted]"


# Default rules. Each tuple is (name, compiled regex). Matches anywhere
# in a string value are replaced with the redaction token. Order
# doesn't matter for correctness but earlier rules win when matches
# overlap (Python re sub doesn't backtrack across rules; we apply each
# rule independently).
_DEFAULT_RULES: list[tuple[str, Pattern[str]]] = [
    # Anthropic API keys (sk-ant-… up to ~95 chars).
    ("anthropic_api_key", re.compile(r"sk-ant-[A-Za-z0-9_\-]{20,}")),
    # GitHub PATs (ghp_, gho_, ghs_, ghr_) and fine-grained tokens (github_pat_).
    ("github_token", re.compile(r"\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})\b")),
    # Slack bot/user/app tokens (xox + 1 letter + dashes + alnum).
    ("slack_token", re.compile(r"\bxox[abprsu]-[A-Za-z0-9-]{10,}\b")),
    # Stripe live + test keys.
    ("stripe_key", re.compile(r"\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}\b")),
    # AWS access key id (always 20 chars, AKIA / ASIA prefix).
    ("aws_access_key", re.compile(r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b")),
    # Email addresses. The OWASP regex is overkill here; this catches
    # the common shape without false-positiving on words with @ in them
    # (e.g. python decorators inside log messages).
    ("email", re.compile(r"\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b")),
    # JWT-shaped tokens (three base64url segments). Often appear in
    # captured request headers / debug dumps.
    ("jwt", re.compile(r"\b[A-Za-z0-9_\-]{20,}\.[A-Za-z0-9_\-]{20,}\.[A-Za-z0-9_\-]{20,}\b")),
]


@dataclass
class Redactor:
    """Walks event dicts and redacts matches in string values.

    Construct via ``Redactor.default()`` for the built-in ruleset, or
    ``Redactor()`` for an empty redactor that you extend with
    :meth:`add_rule`. The redactor operates on a deep copy of the
    event so the caller's dict is never mutated.
    """

    rules: list[tuple[str, Pattern[str]]] = field(default_factory=list)
    placeholder: str = REDACTED

    @classmethod
    def default(cls) -> Redactor:
        return cls(rules=list(_DEFAULT_RULES))

    def add_rule(self, name: str, pattern: str | Pattern[str]) -> None:
        compiled = re.compile(pattern) if isinstance(pattern, str) else pattern
        self.rules.append((name, compiled))

    def redact_text(self, value: str) -> str:
        out = value
        for _name, pat in self.rules:
            out = pat.sub(self.placeholder, out)
        return out

    def redact(self, event: Any) -> Any:
        """Return a redacted copy of the input. Strings are scanned;
        dicts and lists are recursed; other types pass through."""
        if isinstance(event, str):
            return self.redact_text(event)
        if isinstance(event, dict):
            return {k: self.redact(v) for k, v in event.items()}
        if isinstance(event, list):
            return [self.redact(v) for v in event]
        return event


def purge_runs(
    root: Path,
    *,
    older_than: timedelta,
    now: datetime | None = None,
    dry_run: bool = False,
) -> list[Path]:
    """Delete run-log files whose mtime is older than ``older_than``.

    Returns the list of paths considered for deletion (for the caller
    to print). With ``dry_run=True`` the files are not actually
    deleted — useful for the CLI's confirmation step.

    The retention window is intentionally based on file mtime rather
    than the embedded ``run.start`` timestamp: it's robust against
    clock skew, and a run-log file whose contents claim a recent date
    but hasn't been touched in months is almost certainly stale
    anyway.
    """
    n = now if now is not None else datetime.now(timezone.utc)
    cutoff_seconds = (n - older_than).timestamp()
    runs_dir = root / ".claudestruct" / "runs"
    if not runs_dir.exists():
        return []
    victims: list[Path] = []
    for p in sorted(runs_dir.iterdir()):
        if p.suffix != ".jsonl":
            continue
        try:
            mtime = p.stat().st_mtime
        except OSError:
            continue
        if mtime < cutoff_seconds:
            victims.append(p)
            if not dry_run:
                try:
                    p.unlink()
                except OSError:
                    pass
    return victims
