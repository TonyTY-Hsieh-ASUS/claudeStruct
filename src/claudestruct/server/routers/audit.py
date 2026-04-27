"""Audit-log read endpoints (W8.4).

The audit chain is **append-only via every other route** — there is
no `POST /v1/audit`. These endpoints expose the chain for inspection
+ tamper-evidence verification, scoped to the principal's org.

- ``GET /v1/audit/head``  — `{seq, entry_hash}` for the latest row.
  Operators store this externally (CI artifact, monthly email) and
  later compare to detect tampering.
- ``GET /v1/audit``       — paginated list (most-recent-first). Admin-only.
- ``GET /v1/audit/verify`` — walks the chain forward, returns
  `{ok, total, head_seq, head_hash, broken_at_seq?, broken_reason?}`.
"""
from __future__ import annotations

import json

from fastapi import APIRouter, Depends, Query, Response
from sqlalchemy import select
from sqlalchemy.orm import Session

from claudestruct.server import audit as audit_mod
from claudestruct.server import auth as auth_mod
from claudestruct.server.models import Role
from claudestruct.server.schema import (
    AuditEntryResponse,
    AuditHeadResponse,
    AuditListResponse,
    AuditVerifyResponse,
)

router = APIRouter(prefix="/v1/audit", tags=["audit"])


@router.get("/head", response_model=AuditHeadResponse)
def get_head(
    response: Response,
    principal: auth_mod.Principal = Depends(auth_mod.require_role(Role.viewer)),
    session: Session = Depends(auth_mod.get_session),
) -> AuditHeadResponse:
    head = audit_mod.head_for_org(session, principal.org_id)
    if head is None:
        # Empty chain: return the genesis hash so external snapshots
        # can be initialized against a known-good baseline.
        return AuditHeadResponse(seq=0, entry_hash=audit_mod.GENESIS_HASH)
    return AuditHeadResponse(seq=head.seq, entry_hash=head.entry_hash)


@router.get("", response_model=AuditListResponse)
def list_entries(
    limit: int = Query(default=50, ge=1, le=500),
    cursor_seq: int | None = Query(
        default=None,
        description="Return rows with seq strictly less than this. Use the smallest seq from the previous page.",
    ),
    principal: auth_mod.Principal = Depends(auth_mod.require_role(Role.admin)),
    session: Session = Depends(auth_mod.get_session),
) -> AuditListResponse:
    stmt = (
        select(audit_mod.AuditEntry)
        .where(audit_mod.AuditEntry.org_id == principal.org_id)
        .order_by(audit_mod.AuditEntry.seq.desc())
        .limit(limit)
    )
    if cursor_seq is not None:
        stmt = stmt.where(audit_mod.AuditEntry.seq < cursor_seq)
    rows = session.execute(stmt).scalars().all()
    entries: list[AuditEntryResponse] = []
    for row in rows:
        try:
            payload = json.loads(row.payload_json)
        except json.JSONDecodeError:
            payload = None
        entries.append(AuditEntryResponse(
            seq=row.seq,
            action=row.action,
            resource_type=row.resource_type,
            resource_id=row.resource_id,
            payload=payload,
            actor_user_id=row.actor_user_id,
            created_at=row.created_at,
            prev_hash=row.prev_hash,
            entry_hash=row.entry_hash,
        ))
    next_cursor = entries[-1].seq if len(entries) == limit else None
    return AuditListResponse(entries=entries, next_cursor_seq=next_cursor)


@router.get("/verify", response_model=AuditVerifyResponse)
def verify(
    principal: auth_mod.Principal = Depends(auth_mod.require_role(Role.admin)),
    session: Session = Depends(auth_mod.get_session),
) -> AuditVerifyResponse:
    report = audit_mod.verify_chain(session, principal.org_id)
    return AuditVerifyResponse(
        ok=report.ok,
        total=report.total,
        head_seq=report.head_seq,
        head_hash=report.head_hash,
        broken_at_seq=report.broken_at_seq,
        broken_reason=report.broken_reason,
    )
