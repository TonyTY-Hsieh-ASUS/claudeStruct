"""SQLAlchemy engine + session factory.

Default DB URL is `sqlite:///./.claudestruct/server.db` so a fresh
install boots without external infra. Override via the
`CLAUDESTRUCT_DATABASE_URL` env var (e.g. `postgresql+psycopg://...`)
or `cs serve --db-url`.

For the draft we call `Base.metadata.create_all(engine)` from
`init_db()` — idempotent, no Alembic dependency. When migration
support is needed (schema bumps without dropping data), swap to
Alembic without breaking the public API.
"""
from __future__ import annotations

import os
from pathlib import Path

from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker


DEFAULT_DB_URL = "sqlite:///./.claudestruct/server.db"


class Base(DeclarativeBase):
    """Shared declarative base for every model in this package."""


def resolve_db_url(override: str | None = None) -> str:
    """Pick the DB URL. Priority: explicit override > env > default."""
    if override:
        return override
    return os.environ.get("CLAUDESTRUCT_DATABASE_URL", DEFAULT_DB_URL)


def make_engine(db_url: str | None = None):
    """Build an Engine. SQLite gets ``check_same_thread=False`` so the
    FastAPI thread pool can share the connection pool. Other backends
    use SQLAlchemy's defaults."""
    url = resolve_db_url(db_url)
    if url.startswith("sqlite"):
        # Ensure the SQLite directory exists for the default path.
        if url.startswith("sqlite:///"):
            target = url.removeprefix("sqlite:///")
            if target and target != ":memory:":
                Path(target).parent.mkdir(parents=True, exist_ok=True)
        return create_engine(url, connect_args={"check_same_thread": False})
    return create_engine(url)


def make_session_factory(engine) -> sessionmaker[Session]:
    return sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


def init_db(engine) -> None:
    """Create all tables that don't yet exist. Safe to call repeatedly."""
    # Import for the side effect of registering the models on Base.metadata.
    from claudestruct.server import models  # noqa: F401

    Base.metadata.create_all(engine)
