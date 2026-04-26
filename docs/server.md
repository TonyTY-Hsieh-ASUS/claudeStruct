# `cs serve` — daemon mode (draft)

The `cs serve` subcommand boots a long-running HTTP API around the same
context-gathering and budgeting machinery as the one-shot CLI. Two
Wave-6 capabilities ship in this draft:

- **W6.2 — REST API**. FastAPI app with auto-generated OpenAPI spec
  at `/openapi.json` and an interactive viewer at `/docs`.
- **W6.3 — Multi-tenant RBAC**. Postgres-ready SQLAlchemy schema
  (`orgs`, `users`, `memberships`, `api_keys`) with three roles
  (`admin`, `member`, `viewer`).

!!! note "Run execution lands in W6.1"
    `POST /v1/runs` currently returns `202 Accepted` with a placeholder
    run_id. The actual worker model — Postgres job queue, retry,
    timeouts — arrives in **W6.1 (daemon mode)** on top of this
    skeleton.

## Install

The server pulls in FastAPI, uvicorn, SQLAlchemy, and pydantic, so it
ships behind an optional extra to keep the lean install lean.

```bash
pip install 'claudestruct[server]'
```

## Bootstrap

```bash
# 1. Create the DB schema (idempotent).
cs serve init-db

# 2. Create an org.
cs serve add-org acme "Acme Inc"

# 3. Add a user with a role: admin / member / viewer.
cs serve add-user alice@acme.example acme --name Alice --role admin

# 4. Mint an API key (printed exactly once — store it now).
cs serve add-key alice@acme.example acme --name "alice-laptop"
# key_id=abcd1234abcd1234
# full_key=ck_abcd1234abcd1234_<48-hex-chars>
```

The default DB URL is `sqlite:///./.claudestruct/server.db`. Override
with `--db-url` or the `CLAUDESTRUCT_DATABASE_URL` env var
(e.g. `postgresql+psycopg://user:pass@host/db`).

## Run the API

```bash
cs serve run --host 127.0.0.1 --port 8787
# INFO:     Uvicorn running on http://127.0.0.1:8787
```

Bind to `0.0.0.0` only when there's a TLS terminator in front (nginx,
Traefik, ALB). The draft does not implement TLS itself.

## Calling the API

```bash
KEY=ck_...

# Health probe (unauthenticated).
curl http://localhost:8787/healthz

# Read-only endpoints (viewer or higher).
curl -H "Authorization: Bearer $KEY" http://localhost:8787/v1/dashboard
curl -H "Authorization: Bearer $KEY" http://localhost:8787/v1/budget
curl -H "Authorization: Bearer $KEY" "http://localhost:8787/v1/budget?cap_usd=100"

# Submit a run (member or higher). Today returns 202 with a placeholder.
curl -H "Authorization: Bearer $KEY" \
     -H "Content-Type: application/json" \
     -d '{"task":"dev","description":"add retry to client.py"}' \
     http://localhost:8787/v1/runs

# Manage keys (admin only).
curl -X POST -H "Authorization: Bearer $KEY" \
     -d '{"name":"ci"}' http://localhost:8787/v1/keys
curl -X DELETE -H "Authorization: Bearer $KEY" \
     http://localhost:8787/v1/keys/<key_id>
```

## Auth model

API keys have the shape `ck_<key_id>_<secret>`:

- `key_id` — 16-hex-char public prefix, stored in the DB. Useful for
  audit logs (the prefix identifies the key without leaking the
  secret).
- `secret` — 48-hex-char tail. Only `sha256(secret)` is persisted;
  the full key is shown once at issuance and can never be
  retrieved. Hashing means a DB read doesn't yield live keys.

The bearer token middleware (see `server/auth.py`) parses the key,
matches `key_id` in the DB, constant-time-compares the secret hash,
and ensures the user still has an active membership in the
key's org. On success it stamps `last_used_at` and yields a
`Principal(user_id, org_id, role)` to the route.

## Roles

| Role     | Read dashboards / runs | Submit runs | Manage keys |
| -------- | :--------------------: | :---------: | :---------: |
| viewer   | ✓                      |             |             |
| member   | ✓                      | ✓           |             |
| admin    | ✓                      | ✓           | ✓           |

`require_role(min_role)` is the FastAPI dependency that enforces this;
roles are ranked by the `_ROLE_RANK` map in `server/auth.py`.

## Limitations of this draft

- No run execution (W6.1).
- No OAuth login (W6.4) — keys only.
- No org-level dashboard scoping for run logs (the dashboard reads
  `<run_root>/.claudestruct/runs/` directly; once W6.1 lands, runs
  will live in the DB and be tenant-scoped at the row level).
- No GitHub App integration (W6.6).
