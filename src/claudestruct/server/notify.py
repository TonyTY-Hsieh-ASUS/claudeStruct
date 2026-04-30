"""Notification surface for hosted-side alerts (W6.5).

Two providers:

- ``LogNotifier`` — writes structured JSON to stdlib logging at WARNING.
  Default; safe in every environment, no external deps.
- ``SlackWebhookNotifier`` — POSTs an incoming-webhook payload to a
  Slack channel URL. Used by hosted deployments that have wired up a
  Slack workspace.

A future ``EmailNotifier`` slots in via the same Protocol; the alert
producers (``alerts.py``) only see ``Notifier``.

Provider selection is env-driven so the ``cs serve alerts`` command
doesn't grow N flags for N future channels:

    CLAUDESTRUCT_NOTIFY_PROVIDER=log                  (default)
    CLAUDESTRUCT_NOTIFY_PROVIDER=slack
        CLAUDESTRUCT_SLACK_WEBHOOK_URL=https://hooks.slack.com/...

Test seam: producers should call ``notifier.notify(alert)`` rather
than constructing a provider directly so unit tests can swap in a
``CapturingNotifier`` and assert on the calls.
"""
from __future__ import annotations

import json
import logging
import os
from dataclasses import asdict, dataclass, is_dataclass
from typing import Any, Protocol

log = logging.getLogger("claudestruct.notify")


# --- Alert payload --------------------------------------------------


@dataclass(frozen=True)
class Alert:
    """Stable wire format. Producers populate the relevant fields and
    leave the rest empty rather than inventing per-channel shapes.

    ``severity`` is "info" / "warning" / "critical" — the Slack
    formatter colour-codes by it; the log formatter promotes critical
    to ERROR.
    """
    kind: str          # "cost_regression", "budget_breach", ...
    severity: str      # "info" / "warning" / "critical"
    org_slug: str
    summary: str       # one-line human-readable headline
    details: dict[str, Any]


# --- Notifier protocol ----------------------------------------------


class Notifier(Protocol):
    name: str

    def notify(self, alert: Alert) -> None: ...


# --- Providers ------------------------------------------------------


class LogNotifier:
    """Default provider. Writes a single JSON line per alert at WARNING
    (or ERROR for ``severity="critical"``). Suitable for every
    environment — node-exporter / loki / journald all consume it."""

    name = "log"

    def notify(self, alert: Alert) -> None:
        payload = json.dumps(asdict(alert) if is_dataclass(alert) else alert)
        if alert.severity == "critical":
            log.error("alert %s", payload)
        else:
            log.warning("alert %s", payload)


class SlackWebhookNotifier:
    """POSTs a Slack incoming-webhook payload.

    The webhook URL is an opaque secret — keep it out of logs and
    error messages. We use a per-instance ``http_client`` (default
    lazy-imported ``httpx``) so tests don't make real network calls.
    """

    name = "slack"

    def __init__(self, webhook_url: str, *, http_client: Any | None = None) -> None:
        if not webhook_url:
            raise ValueError("SlackWebhookNotifier requires a non-empty webhook URL")
        self._url = webhook_url
        self._http_client = http_client

    def _client(self) -> Any:
        if self._http_client is not None:
            return self._http_client
        # Lazy-import: keeps the lean install free of httpx until a
        # Slack notifier is actually constructed.
        import httpx
        return httpx.Client()

    def notify(self, alert: Alert) -> None:
        colour = {
            "critical": "#cc0000",
            "warning": "#cc9900",
            "info": "#3399cc",
        }.get(alert.severity, "#666666")
        payload = {
            "text": f"[{alert.severity.upper()}] {alert.org_slug}: {alert.summary}",
            "attachments": [{
                "color": colour,
                "fields": [
                    {"title": "kind", "value": alert.kind, "short": True},
                    {"title": "org", "value": alert.org_slug, "short": True},
                    *[
                        {"title": k, "value": str(v), "short": True}
                        for k, v in alert.details.items()
                    ],
                ],
            }],
        }
        client = self._client()
        try:
            resp = client.post(self._url, json=payload, timeout=10.0)
        finally:
            close = getattr(client, "close", None)
            # Only close if we built our own client; injected ones are
            # the caller's responsibility.
            if callable(close) and self._http_client is None:
                close()
        # Slack returns 200 + body "ok" on success. We log + swallow on
        # error — an alert delivery failure shouldn't crash the worker
        # that produced it.
        if getattr(resp, "status_code", 500) != 200:
            log.warning(
                "slack webhook returned %s; alert dropped",
                getattr(resp, "status_code", "<no-status>"),
            )


# --- Factory --------------------------------------------------------


def default_notifier() -> Notifier:
    """Build the configured provider.

    Defaults to ``LogNotifier`` so a fresh deployment never silently
    swallows alerts to a broken Slack URL — the operator has to opt in.
    """
    name = os.environ.get("CLAUDESTRUCT_NOTIFY_PROVIDER", "log").strip().lower()
    if name == "log":
        return LogNotifier()
    if name == "slack":
        url = os.environ.get("CLAUDESTRUCT_SLACK_WEBHOOK_URL", "").strip()
        if not url:
            raise RuntimeError(
                "CLAUDESTRUCT_NOTIFY_PROVIDER=slack requires "
                "CLAUDESTRUCT_SLACK_WEBHOOK_URL to be set"
            )
        return SlackWebhookNotifier(url)
    raise RuntimeError(
        f"unknown CLAUDESTRUCT_NOTIFY_PROVIDER={name!r}; expected one of: log, slack"
    )
