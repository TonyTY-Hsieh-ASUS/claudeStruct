"""Daemon-mode REST API + multi-tenant RBAC for claudeStruct (W6.2 + W6.3).

Optional package — pulled in by `pip install 'claudestruct[server]'`.
The CLI's `cs serve` subcommand boots a uvicorn server on top of
`create_app()`; `cs serve init-db / add-user / add-key` cover the
bootstrap flows for a fresh install.

Architecture (draft):
    HTTP request
        v
    api-key middleware  (auth.py: Bearer ck_... lookup)
        v
    role check         (auth.py: RBAC dependency)
        v
    router             (routers/*.py)
        v
    SQLAlchemy session (db.py)
        v
    SQLite (default) / Postgres (production)

Run execution itself stays in-CLI for the draft — `POST /v1/runs`
returns 202 with a placeholder run_id. The actual worker model lands
in W6.1 (daemon mode) on top of this skeleton.
"""
from claudestruct.server.app import create_app

__all__ = ["create_app"]
