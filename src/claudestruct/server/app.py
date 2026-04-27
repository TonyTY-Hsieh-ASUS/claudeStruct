"""FastAPI app factory.

``create_app(...)`` is the single seam for tests and the ``cs serve``
launcher. It builds the engine + session factory, wires up
``app.state``, and mounts the routers. The OpenAPI doc is auto-generated
at ``/openapi.json`` (FastAPI default); ``/docs`` and ``/redoc`` serve
the interactive viewer.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

from fastapi import FastAPI

from claudestruct import __version__
from claudestruct.server.db import init_db, make_engine, make_session_factory
from claudestruct.server.routers import (
    audit as audit_router,
)
from claudestruct.server.routers import (
    billing as billing_router,
)
from claudestruct.server.routers import (
    budget as budget_router,
)
from claudestruct.server.routers import (
    dashboard as dashboard_router,
)
from claudestruct.server.routers import (
    github as github_router,
)
from claudestruct.server.routers import (
    health as health_router,
)
from claudestruct.server.routers import (
    keys as keys_router,
)
from claudestruct.server.routers import (
    oauth as oauth_router,
)
from claudestruct.server.routers import (
    runs as runs_router,
)


def create_app(
    *,
    db_url: str | None = None,
    run_root: str | Path | None = None,
    engine: Any = None,
    skip_init: bool = False,
) -> FastAPI:
    """Build the FastAPI app.

    Args:
        db_url: SQLAlchemy URL. Defaults to env ``CLAUDESTRUCT_DATABASE_URL``
            or ``sqlite:///./.claudestruct/server.db``.
        run_root: Directory whose ``.claudestruct/runs/`` is read by the
            dashboard / budget / runs endpoints. Defaults to cwd.
        engine: Pre-built SQLAlchemy engine (tests use this with an
            in-memory SQLite to avoid touching the filesystem).
        skip_init: Skip the ``Base.metadata.create_all`` call. Useful
            when the engine is shared across test app instances and
            tables already exist.
    """
    eng = engine if engine is not None else make_engine(db_url)
    if not skip_init:
        init_db(eng)

    app = FastAPI(
        title="claudeStruct",
        version=__version__,
        description=(
            "REST API for the claudeStruct daemon. Authentication is "
            "Bearer-token (`ck_<key_id>_<secret>`). RBAC roles: admin, "
            "member, viewer. See `cs serve --help` for setup."
        ),
    )
    app.state.session_factory = make_session_factory(eng)
    app.state.engine = eng
    app.state.run_root = str(run_root) if run_root else "."

    app.include_router(health_router.router)
    app.include_router(keys_router.router)
    app.include_router(dashboard_router.router)
    app.include_router(budget_router.router)
    app.include_router(runs_router.router)
    app.include_router(audit_router.router)
    app.include_router(billing_router.router)
    app.include_router(github_router.router)
    app.include_router(oauth_router.router)

    return app
