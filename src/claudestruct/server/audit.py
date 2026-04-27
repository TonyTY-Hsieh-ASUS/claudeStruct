"""Append-only hash-chained audit log (W8.4).

Every state-changing API call writes an :class:`AuditEntry` row whose
``entry_hash`` is `sha256(prev_hash || canonical_payload)`. The chain
root for an org is the hash of the most recent entry — exposing it
via the API gives the operator a constant-time tamper-evidence
verification: store the root externally (in a CI artifact, monthly
email, etc.) and compare on inspection.

Defenses:
- Tampering with any past row breaks the chain at that point because
  the next row's ``entry_hash`` was computed against the original
  ``prev_hash``. :func:`verify_chain` walks forward and reports the
  first index that diverges.
- Inserting a forged row in the middle requires recomputing every
  later row's ``entry_hash`` — operationally easy if the attacker has
  DB write but combats casual log-doctoring (e.g. a customer
  questioning "did this admin really revoke my key?").
- This is **not** a replacement for cryptographic signing or an
  external transparency log; the chain is local-only. Pair with
  Wave 9 SOC2 controls when that lands.

Retention:
- Free tier: 90 days
- Paid tier: 7 years (per TODO.md W8.4)

We don't enforce retention here -- a periodic worker (W6.1) will run
:func:`prune_audit` against the ``Subscription.tier`` of each org.

The chain is per-org. Cross-org audit isolation is enforced by
``record()`` (sets ``org_id`` from the principal) and the audit
router (filters by `principal.org_id`).
"""
from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import (
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    select,
)
from sqlalchemy.orm import Mapped, Session, mapped_column

from claudestruct.server.db import Base

GENESIS_HASH = "0" * 64


def _now_utc() -> datetime:
    return datetime.now(timezone.utc)


def _canonical_json(payload: Any) -> str:
    """Deterministic JSON encoding for hashing — keys sorted, no
    whitespace. Two invocations on equal data produce the exact same
    bytes; otherwise the chain wouldn't be portable across DB engines
    or Python versions."""
    return json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def compute_entry_hash(
    *,
    prev_hash: str,
    org_id: int,
    actor_user_id: int | None,
    action: str,
    resource_type: str,
    resource_id: str,
    payload: Any,
    created_at: datetime,
) -> str:
    """Hash a row's identity fields together with the chain link.

    `created_at` is included so a re-ordered or backdated row breaks
    the chain. Microsecond precision is normalized to ISO-8601 to
    avoid driver-specific datetime quirks.
    """
    blob = "|".join([
        prev_hash,
        str(org_id),
        str(actor_user_id) if actor_user_id is not None else "",
        action,
        resource_type,
        resource_id,
        _canonical_json(payload),
        created_at.astimezone(timezone.utc).isoformat(timespec="microseconds"),
    ])
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()


class AuditEntry(Base):
    __tablename__ = "audit_entries"

    id: Mapped[int] = mapped_column(primary_key=True)
    org_id: Mapped[int] = mapped_column(
        ForeignKey("orgs.id", ondelete="CASCADE"), index=True
    )
    actor_user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    # Examples: "key.create" / "key.revoke" / "run.submit". Lowercase
    # dotted form for grep-ability and downstream filtering.
    action: Mapped[str] = mapped_column(String(64))
    resource_type: Mapped[str] = mapped_column(String(64))
    resource_id: Mapped[str] = mapped_column(String(128))
    payload_json: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_now_utc
    )
    # Per-org sequence so verification doesn't have to load the whole
    # table. seq=1 is the first entry; seq=N's prev_hash is seq=N-1's
    # entry_hash.
    seq: Mapped[int] = mapped_column(Integer)
    prev_hash: Mapped[str] = mapped_column(String(64))
    entry_hash: Mapped[str] = mapped_column(String(64), index=True)

    __table_args__ = (
        # One sequence per org. Lets us SELECT MAX(seq) without an
        # extra index lookup.
        Index("ix_audit_org_seq", "org_id", "seq", unique=True),
    )


@dataclass(frozen=True)
class HeadInfo:
    seq: int
    entry_hash: str


def head_for_org(session: Session, org_id: int) -> HeadInfo | None:
    """Return the (seq, entry_hash) of the latest audit row for an org,
    or None if no rows exist yet."""
    row = session.execute(
        select(AuditEntry.seq, AuditEntry.entry_hash)
        .where(AuditEntry.org_id == org_id)
        .order_by(AuditEntry.seq.desc())
        .limit(1)
    ).first()
    if row is None:
        return None
    return HeadInfo(seq=row[0], entry_hash=row[1])


def record(
    session: Session,
    *,
    org_id: int,
    actor_user_id: int | None,
    action: str,
    resource_type: str,
    resource_id: str,
    payload: Any,
) -> AuditEntry:
    """Append a new row with the chain link computed.

    Caller is responsible for the surrounding session lifecycle —
    this writes (and flushes so ``entry_hash`` stays canonical) but
    does not commit. The HTTP middleware that issues the call commits
    once the request handler returns successfully.
    """
    head = head_for_org(session, org_id)
    seq = (head.seq if head else 0) + 1
    prev_hash = head.entry_hash if head else GENESIS_HASH
    created_at = _now_utc()
    entry_hash = compute_entry_hash(
        prev_hash=prev_hash,
        org_id=org_id,
        actor_user_id=actor_user_id,
        action=action,
        resource_type=resource_type,
        resource_id=resource_id,
        payload=payload,
        created_at=created_at,
    )
    row = AuditEntry(
        org_id=org_id,
        actor_user_id=actor_user_id,
        action=action,
        resource_type=resource_type,
        resource_id=resource_id,
        payload_json=_canonical_json(payload),
        created_at=created_at,
        seq=seq,
        prev_hash=prev_hash,
        entry_hash=entry_hash,
    )
    session.add(row)
    session.flush()
    return row


@dataclass(frozen=True)
class VerifyReport:
    ok: bool
    total: int
    head_seq: int | None
    head_hash: str | None
    broken_at_seq: int | None  # None when ok is True
    broken_reason: str | None  # one-liner; None when ok is True


def verify_chain(session: Session, org_id: int) -> VerifyReport:
    """Walk the per-org chain forward from seq=1 and confirm every
    row's ``entry_hash`` matches a fresh recomputation against its
    declared ``prev_hash``. The first divergence wins."""
    rows = session.execute(
        select(AuditEntry)
        .where(AuditEntry.org_id == org_id)
        .order_by(AuditEntry.seq.asc())
    ).scalars().all()

    if not rows:
        return VerifyReport(
            ok=True, total=0, head_seq=None, head_hash=None,
            broken_at_seq=None, broken_reason=None,
        )

    expected_prev = GENESIS_HASH
    expected_seq = 1
    for row in rows:
        if row.seq != expected_seq:
            return VerifyReport(
                ok=False, total=len(rows),
                head_seq=rows[-1].seq, head_hash=rows[-1].entry_hash,
                broken_at_seq=row.seq,
                broken_reason=f"seq gap: expected {expected_seq}, found {row.seq}",
            )
        if row.prev_hash != expected_prev:
            return VerifyReport(
                ok=False, total=len(rows),
                head_seq=rows[-1].seq, head_hash=rows[-1].entry_hash,
                broken_at_seq=row.seq,
                broken_reason=f"prev_hash mismatch at seq {row.seq}",
            )
        # Reload payload from canonical JSON so a comparison against
        # the stored bytes is exact.
        try:
            payload = json.loads(row.payload_json)
        except json.JSONDecodeError:
            return VerifyReport(
                ok=False, total=len(rows),
                head_seq=rows[-1].seq, head_hash=rows[-1].entry_hash,
                broken_at_seq=row.seq,
                broken_reason=f"payload not valid JSON at seq {row.seq}",
            )
        recomputed = compute_entry_hash(
            prev_hash=row.prev_hash,
            org_id=row.org_id,
            actor_user_id=row.actor_user_id,
            action=row.action,
            resource_type=row.resource_type,
            resource_id=row.resource_id,
            payload=payload,
            created_at=row.created_at,
        )
        if recomputed != row.entry_hash:
            return VerifyReport(
                ok=False, total=len(rows),
                head_seq=rows[-1].seq, head_hash=rows[-1].entry_hash,
                broken_at_seq=row.seq,
                broken_reason=f"entry_hash divergence at seq {row.seq}",
            )
        expected_prev = row.entry_hash
        expected_seq += 1

    last = rows[-1]
    return VerifyReport(
        ok=True, total=len(rows),
        head_seq=last.seq, head_hash=last.entry_hash,
        broken_at_seq=None, broken_reason=None,
    )


def prune_audit(
    session: Session,
    *,
    org_id: int,
    older_than_days: int,
    now: datetime | None = None,
) -> int:
    """Remove audit entries older than ``older_than_days``. Returns
    the count deleted. Note: this **breaks the chain** if pruned rows
    don't include the genesis. Callers should verify the new head
    against an external snapshot before / after pruning.

    Retention policy is org-tier-driven (free=90d, paid=7y); enforcing
    that lives outside this module so the rule lives next to the
    subscription state.
    """
    n = now if now is not None else _now_utc()
    cutoff = n - timedelta(days=older_than_days)
    rows = session.execute(
        select(AuditEntry).where(
            AuditEntry.org_id == org_id,
            AuditEntry.created_at < cutoff,
        )
    ).scalars().all()
    for row in rows:
        session.delete(row)
    return len(rows)
