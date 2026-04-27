"""Multi-tenant RBAC schema (W6.3).

Minimal shape for the draft:

- ``Org`` — billing + isolation boundary. Every run, key, and membership
  is org-scoped.
- ``User`` — global identity (one row per email). A user can belong to
  multiple orgs via ``Membership``.
- ``Membership`` — (user, org) pair plus a role: ``admin``,
  ``member``, ``viewer``. Roles are checked at request time by
  ``auth.require_role``.
- ``ApiKey`` — opaque bearer token used by the CLI / CI. Stored as a
  SHA-256 of the secret so a DB compromise doesn't leak live keys.
  ``key_id`` is the user-visible prefix (e.g. ``ck_live_abcd``).

Future tables (W6.1+, not in this draft):
- ``Run`` — replaces the JSONL run logs once the daemon owns execution.
- ``AuditLog`` — append-only chain for W8.4.
"""
from __future__ import annotations

from datetime import datetime, timezone
from enum import Enum

from sqlalchemy import DateTime, ForeignKey, String
from sqlalchemy.orm import Mapped, mapped_column, relationship

from claudestruct.server.db import Base


class Role(str, Enum):
    """Membership roles. String values match the DB column for simple
    comparisons in middleware."""

    admin = "admin"     # manage org, users, keys
    member = "member"   # submit runs, read dashboards
    viewer = "viewer"   # read-only


def _now_utc() -> datetime:
    return datetime.now(timezone.utc)


class Org(Base):
    __tablename__ = "orgs"

    id: Mapped[int] = mapped_column(primary_key=True)
    slug: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    name: Mapped[str] = mapped_column(String(255))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now_utc)

    memberships: Mapped[list[Membership]] = relationship(
        back_populates="org", cascade="all, delete-orphan"
    )


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(primary_key=True)
    email: Mapped[str] = mapped_column(String(320), unique=True, index=True)
    name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now_utc)

    memberships: Mapped[list[Membership]] = relationship(
        back_populates="user", cascade="all, delete-orphan"
    )
    api_keys: Mapped[list[ApiKey]] = relationship(
        back_populates="user", cascade="all, delete-orphan"
    )


class Membership(Base):
    __tablename__ = "memberships"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    org_id: Mapped[int] = mapped_column(ForeignKey("orgs.id", ondelete="CASCADE"), index=True)
    role: Mapped[str] = mapped_column(String(16), default=Role.member.value)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now_utc)

    user: Mapped[User] = relationship(back_populates="memberships")
    org: Mapped[Org] = relationship(back_populates="memberships")


class ApiKey(Base):
    __tablename__ = "api_keys"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    org_id: Mapped[int] = mapped_column(ForeignKey("orgs.id", ondelete="CASCADE"), index=True)
    key_id: Mapped[str] = mapped_column(String(32), unique=True, index=True)
    hashed_secret: Mapped[str] = mapped_column(String(128))
    name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now_utc)
    last_used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    user: Mapped[User] = relationship(back_populates="api_keys")

    def is_active(self) -> bool:
        return self.revoked_at is None


class RunStatus(str, Enum):
    """Run state machine. Linear progression queued → running → done|failed.

    `done` covers normal completion; `failed` is reserved for exceptions
    that the worker caught (API error, timeout, etc.) so the API can
    surface a useful message to the requester."""

    queued = "queued"
    running = "running"
    done = "done"
    failed = "failed"


class Run(Base):
    """A daemon-mode submission (W6.1).

    Runs land here via `POST /v1/runs` with `status="queued"`. A worker
    picks one up, sets `status="running"`, executes
    `runner.run_task_and_log` synchronously, then writes the final
    cost/token numbers + `status="done"` (or `"failed"` with `error`).

    The run's JSONL event log still lives at the dashboard's existing
    `<run_root>/.claudestruct/runs/<run_id>.jsonl` location; the DB row
    is the queryable index, the JSONL file is the streaming detail.
    """

    __tablename__ = "runs"

    id: Mapped[int] = mapped_column(primary_key=True)
    run_id: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    org_id: Mapped[int] = mapped_column(ForeignKey("orgs.id", ondelete="CASCADE"), index=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    status: Mapped[str] = mapped_column(String(16), default=RunStatus.queued.value, index=True)

    # Request shape — kept on the row for audit + replay even after
    # the JSONL log is purged.
    task: Mapped[str] = mapped_column(String(16))
    description: Mapped[str] = mapped_column(String(8192))
    model: Mapped[str | None] = mapped_column(String(64), nullable=True)
    effort: Mapped[str | None] = mapped_column(String(16), nullable=True)
    paths_json: Mapped[str | None] = mapped_column(String(2048), nullable=True)

    # Outcomes — populated by the worker on success/failure.
    cost_usd: Mapped[float] = mapped_column(default=0.0)
    input_tokens: Mapped[int] = mapped_column(default=0)
    output_tokens: Mapped[int] = mapped_column(default=0)
    cache_read_tokens: Mapped[int] = mapped_column(default=0)
    cache_creation_tokens: Mapped[int] = mapped_column(default=0)
    duration_ms: Mapped[int | None] = mapped_column(nullable=True)
    error: Mapped[str | None] = mapped_column(String(4096), nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now_utc)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    ended_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
