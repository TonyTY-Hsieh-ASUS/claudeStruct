"""Bearer-token auth + RBAC (W6.3).

API key shape: ``ck_<key_id>_<secret>`` where ``key_id`` is the
user-visible 16-char prefix stored in the DB and ``secret`` is the
high-entropy tail. Only ``sha256(secret)`` is persisted; the full key
is shown once at issuance and can never be retrieved.

The :func:`current_principal` FastAPI dependency authenticates the
request and yields a :class:`Principal` (user + org + role). Routes
that need elevation declare it via :func:`require_role`.
"""
from __future__ import annotations

import hashlib
import secrets
from dataclasses import dataclass
from datetime import datetime, timezone

from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import select
from sqlalchemy.orm import Session

from claudestruct.server.models import ApiKey, Membership, Org, Role, User

_KEY_PREFIX = "ck_"
_KEY_ID_BYTES = 8       # 16 hex chars
_KEY_SECRET_BYTES = 24  # 48 hex chars

_bearer_scheme = HTTPBearer(auto_error=False)


@dataclass(frozen=True)
class Principal:
    """Authenticated request context."""

    user_id: int
    user_email: str
    org_id: int
    org_slug: str
    role: Role


def generate_key() -> tuple[str, str, str]:
    """Mint a new (full_key, key_id, hashed_secret) triple.

    The full key is returned exactly once — the caller is expected to
    surface it to the user and discard it. Only ``key_id`` and
    ``hashed_secret`` are persisted in the DB.
    """
    key_id = secrets.token_hex(_KEY_ID_BYTES)
    secret = secrets.token_hex(_KEY_SECRET_BYTES)
    full_key = f"{_KEY_PREFIX}{key_id}_{secret}"
    hashed = _hash_secret(secret)
    return full_key, key_id, hashed


def _hash_secret(secret: str) -> str:
    return hashlib.sha256(secret.encode("utf-8")).hexdigest()


def parse_key(full_key: str) -> tuple[str, str] | None:
    """Split a presented key into (key_id, secret). Returns None if
    the shape doesn't match."""
    if not full_key.startswith(_KEY_PREFIX):
        return None
    body = full_key[len(_KEY_PREFIX):]
    parts = body.split("_", 1)
    if len(parts) != 2:
        return None
    key_id, secret = parts
    if not key_id or not secret:
        return None
    return key_id, secret


def authenticate(session: Session, full_key: str) -> Principal | None:
    """Look up the key, validate it, and return the Principal.

    Returns None for any failure mode (unknown key, wrong secret,
    revoked, no membership). Caller maps None to 401.
    """
    parsed = parse_key(full_key)
    if not parsed:
        return None
    key_id, secret = parsed

    api_key = session.execute(
        select(ApiKey).where(ApiKey.key_id == key_id)
    ).scalar_one_or_none()
    if api_key is None or not api_key.is_active():
        return None
    if not secrets.compare_digest(api_key.hashed_secret, _hash_secret(secret)):
        return None

    membership = session.execute(
        select(Membership).where(
            Membership.user_id == api_key.user_id,
            Membership.org_id == api_key.org_id,
        )
    ).scalar_one_or_none()
    if membership is None:
        return None

    user = session.get(User, api_key.user_id)
    org = session.get(Org, api_key.org_id)
    if user is None or org is None:
        return None

    api_key.last_used_at = datetime.now(timezone.utc)
    session.commit()

    return Principal(
        user_id=user.id,
        user_email=user.email,
        org_id=org.id,
        org_slug=org.slug,
        role=Role(membership.role),
    )


def get_session(request: Request) -> Session:
    """FastAPI dependency that yields a session from the app's factory.

    The session factory is attached to ``app.state.session_factory``
    by :func:`server.app.create_app`; tests can override it.
    """
    factory = request.app.state.session_factory
    session: Session = factory()
    try:
        yield session
    finally:
        session.close()


def current_principal(
    creds: HTTPAuthorizationCredentials | None = Depends(_bearer_scheme),
    session: Session = Depends(get_session),
) -> Principal:
    if creds is None or creds.scheme.lower() != "bearer":
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="missing bearer token",
            headers={"WWW-Authenticate": "Bearer"},
        )
    principal = authenticate(session, creds.credentials)
    if principal is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="invalid or revoked API key",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return principal


_ROLE_RANK = {Role.viewer: 0, Role.member: 1, Role.admin: 2}


def require_role(min_role: Role):
    """Dependency factory. ``Depends(require_role(Role.admin))``
    returns the principal if the role is at least ``min_role``,
    otherwise 403."""

    def _dep(principal: Principal = Depends(current_principal)) -> Principal:
        if _ROLE_RANK[principal.role] < _ROLE_RANK[min_role]:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"role '{principal.role.value}' lacks required '{min_role.value}'",
            )
        return principal

    return _dep
