# Audit log (W8.4)

The daemon writes an append-only, hash-chained audit row for every
state-changing API call. The chain is **per-org** and exposes a
constant-time tamper-evidence verification: store the chain root
externally (CI artifact, monthly email) and compare on inspection.

## What gets recorded

| Endpoint                                | Action                       |
| --------------------------------------- | ---------------------------- |
| `POST /v1/keys`                         | `key.create`                 |
| `DELETE /v1/keys/{id}`                  | `key.revoke`                 |
| `POST /v1/runs`                         | `run.submit`                 |
| `POST /v1/billing/checkout`             | `billing.checkout.create`    |
| `POST /v1/billing/webhook`              | `stripe.<event_type>`        |

Every row carries `actor_user_id` (the authenticated principal),
`resource_type` + `resource_id`, a JSON `payload` of the relevant
non-sensitive fields, and the chain link
(`prev_hash`, `entry_hash`).

## Chain structure

```
GENESIS_HASH ── seq=1 ── seq=2 ── seq=3 ── …
                  │         │         │
              entry_hash  entry_hash  entry_hash
              (also       (also       (also
              row 2's     row 3's     row 4's
              prev_hash)  prev_hash)  prev_hash)
```

Each `entry_hash` is `sha256(prev_hash || canonical_payload || …)`.
Tampering with any past row breaks the chain at that point because
the next row's `entry_hash` was computed against the original
`prev_hash`. `verify_chain` walks forward and reports the first
divergence.

`canonical_payload` uses `json.dumps(..., sort_keys=True,
separators=(",", ":"))` so two invocations on equal data hash
identically across DB engines and Python versions.

## API

```bash
# Latest seq + entry_hash. Empty chain returns seq=0 + the
# all-zero genesis sentinel so external snapshots can be
# initialized against a known-good baseline.
curl -H "Authorization: Bearer $KEY" $BASE/v1/audit/head
# {"seq": 42, "entry_hash": "abcd1234..."}

# Paginated list (admin only). Most-recent-first; cursor is the
# smallest seq from the previous page.
curl -H "Authorization: Bearer $KEY" "$BASE/v1/audit?limit=50"
curl -H "Authorization: Bearer $KEY" "$BASE/v1/audit?limit=50&cursor_seq=20"

# Walk the chain forward and report the first divergence (admin only).
curl -H "Authorization: Bearer $KEY" $BASE/v1/audit/verify
# {"ok": true, "total": 42, "head_seq": 42, "head_hash": "abcd..."}
```

## Tamper-evidence workflow

1. **Snapshot regularly**: every nightly CI job stores
   `(seq, entry_hash)` from `/v1/audit/head` as an artifact.
2. **Verify on inspection**: when investigating an incident, fetch
   the historical snapshot, then call `/v1/audit/verify`. If the
   stored snapshot's `entry_hash` doesn't appear at the recorded
   seq position, someone rewrote history.
3. **Out-of-band root publication** (optional): publish the head
   hash to a place the DB operator can't write — pinned
   GitHub commit SHA, public RSS, blockchain timestamp service.
   The chain becomes provably tamper-evident when the external
   log proves a hash existed at a time before the suspected
   tampering.

## What this is NOT

- **Not a cryptographic signing layer.** Anyone with DB write can
  forge a complete chain by recomputing every later hash. Defense
  is against *casual* log-doctoring, not a determined attacker
  who has rooted the DB.
- **Not a transparency log.** A real append-only log (Sigsum,
  Certificate Transparency, etc.) commits roots externally to
  prevent silent rewrites. Pair this with one when SOC2 controls
  ship.
- **Not a replacement for the run-level JSONL log.** Audit captures
  *who did what when*; the run JSONL captures *what Claude said*.
  Different consumers, different retention policies.

## Retention

| Tier      | Retention   |
| --------- | ----------- |
| free      | 90 days     |
| team      | 7 years     |
| business  | 7 years     |

`audit.prune_audit(session, org_id, older_than_days)` enforces this.
A periodic worker (W6.1) reads the org's `Subscription.tier`,
maps to days via `billing.AUDIT_RETENTION_DAYS`, and prunes.
**Pruning breaks the chain** at the new genesis — record the
post-prune head hash to your external snapshot before pruning runs.
