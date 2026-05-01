# Always-on home / company control plane (W10.2)

A 30-minute recipe to turn an always-on Linux box (Asus GX10, NUC, or
small VPS) into your team's claudestruct control plane. The result:

- `cs serve` runs as a systemd unit and survives reboots
- Tailscale fronts inbound traffic without exposing a public port
- Caddy terminates TLS for in-network clients
- The W6.6 GitHub App webhook can land back on `https://cs.<tailnet>.ts.net/v1/github/webhook`
- W6.5 cost-regression alerts have a 24/7 process to fire from
- The W8.7 SLO endpoint accumulates real measurements

This is the deployment layer the W6 / W7 / W8 features always assumed
existed but didn't ship recipes for. Pick this path on a single host;
for multi-host, jump to `deploy/helm/` instead.

## What you need

- A Linux box you own (we'll use the Asus GX10 as the canonical
  target; any amd64 / arm64 Linux works).
- Root access for the install.
- A Tailscale account ([free tier is fine](https://tailscale.com/pricing)).
- Optional: a domain you control if you want a stable HTTPS URL.

## 1. Install claudestruct

```bash
# System-wide so the daemon user can find it.
sudo pip install --break-system-packages 'claudestruct[server,openai,otel,sentry]'

# Or, more sanely, in a venv that the systemd unit points at:
sudo python3 -m venv /opt/claudestruct
sudo /opt/claudestruct/bin/pip install 'claudestruct[server,openai]'
sudo ln -sf /opt/claudestruct/bin/cs /usr/local/bin/cs
```

## 2. System user + state directory

```bash
sudo useradd --system --home /var/lib/claudestruct --create-home claudestruct
sudo install -d -o claudestruct -g claudestruct -m 0750 /var/lib/claudestruct
sudo install -d -o root -g claudestruct -m 0750 /etc/claudestruct
sudo install -m 0640 -o root -g claudestruct \
    deploy/systemd/claudestruct.env.example /etc/claudestruct/env
sudo $EDITOR /etc/claudestruct/env   # paste your API key + tweak knobs
```

The example env has the full menu of knobs (provider switch, region
tag, monthly cap, OTel endpoint, Sentry DSN, local-cache policy).
Default values give you cloud Anthropic + SQLite + bind-on-localhost.

## 3. Drop in the systemd units

```bash
sudo cp deploy/systemd/claudestruct.service /etc/systemd/system/
sudo cp deploy/systemd/claudestruct-worker.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now claudestruct.service
sudo systemctl enable --now claudestruct-worker.service
```

Check both are healthy:

```bash
systemctl status claudestruct claudestruct-worker
journalctl -u claudestruct -f
curl http://127.0.0.1:8787/healthz
```

The hardening directives (`ProtectSystem=strict`, `ProtectHome=read-only`,
`RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6`, `PrivateTmp`, etc.)
sit on top of the W5.5 sandbox profiles — defense in depth even
before you wire up Tailscale.

## 4. Bootstrap the first user + key

```bash
sudo -u claudestruct cs serve init-db
sudo -u claudestruct cs serve add-org acme "Acme"
sudo -u claudestruct cs serve add-user you@example.com acme --role admin
sudo -u claudestruct cs serve add-key you@example.com acme --name laptop
# Save the printed `full_key=ck_...` somewhere safe; it's shown once.
```

Smoke-test from the same host:

```bash
curl -H "Authorization: Bearer ck_..." http://127.0.0.1:8787/v1/dashboard
```

## 5. Tailscale (recommended ingress path)

Tailscale gives you a stable hostname, free TLS, and zero public
exposure. The daemon stays bound to `127.0.0.1`; the `tailscaled`
local-listener does the right thing on the tailnet IP.

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up --ssh --accept-routes
# The hostname Caddy will publish:
tailscale status | head -1
# e.g. cs.example-tailnet.ts.net
```

Drop in the Caddyfile and start it:

```bash
sudo apt install caddy
sudo cp deploy/systemd/Caddyfile.example /etc/caddy/Caddyfile
sudo $EDITOR /etc/caddy/Caddyfile   # replace the hostname
sudo systemctl restart caddy
```

The Caddy config block 1 (Tailscale-only) terminates HTTPS on the
tailnet IP without ACME — Tailscale already handles TLS at the
network layer. From any other tailnet device you can now hit:

```
https://cs.<your-tailnet>.ts.net/v1/dashboard
```

For the GitHub App webhook, this URL is what you paste into the
**Webhook URL** field on the App's settings page. Tailscale Funnel
makes the same hostname reachable from the public Internet without
opening a firewall port:

```bash
sudo tailscale funnel 8787
```

## 6. Optional: public DNS + Let's Encrypt

If you run on a VPS with a real domain instead of (or in addition to)
Tailscale, swap to the second block in `Caddyfile.example`. Caddy
auto-renews ACME certs, sets HSTS, and adds a CORS allowlist for the
W6.4 OAuth-driven SPA.

The daemon's auth chain (W6.4) already does the work: bearer tokens
for the CLI, session cookies for the browser, both backed by RBAC.
There's no CSRF token on POST yet (tracked in W6.4 follow-up), so SPA
mutating calls should keep using the bearer-token path.

## 7. Wire features that needed always-on

- **GitHub App** (W6.6): paste `https://cs.<tailnet>.ts.net/v1/github/webhook` into the App's webhook URL. The signature secret you set in the App's UI goes into `cs serve add-github-install <installation_id> acme --secret <secret>`.
- **Cost-regression alerts** (W6.5): point `CLAUDESTRUCT_NOTIFY_WEBHOOK` at your Slack incoming webhook in `/etc/claudestruct/env`; restart the API service.
- **Nightly review** (W10.8 — pending): set up a `systemd.timer` to invoke `cs review` on `main`'s last 3 commits via `claudestruct.service`'s data dir.

## 8. Backups

Everything important lives under `/var/lib/claudestruct/`:

- `server.db` (SQLite) — orgs, users, keys, runs, audit chain
- `runs/` — JSONL run logs (also feeds the dashboard)
- `memory/` — claw-squad lessons (per-org, optional)
- `llm_cache/` — local prompt cache (W10.4); safe to delete

A nightly `tar` + an encrypted upload to S3 / Backblaze covers it. If
you flip to Postgres in the env file, point pg_dump at the DSN
instead and skip the SQLite file.

## Operations cheat sheet

```bash
# Tail both daemons
journalctl -u claudestruct -u claudestruct-worker -f

# Restart after env-file edits
sudo systemctl restart claudestruct claudestruct-worker

# Drain the queue manually (cron-style; needs `--once`)
sudo -u claudestruct cs serve worker --once

# Inspect spend
curl -H "Authorization: Bearer ck_..." \
    https://cs.<tailnet>.ts.net/v1/billing/usage

# Verify SLOs the cost-regression alerts watch
curl -H "Authorization: Bearer ck_..." \
    https://cs.<tailnet>.ts.net/v1/slo
```

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `claudestruct.service` exits with `exit-code=78` | Env file unreadable | `chown root:claudestruct /etc/claudestruct/env && chmod 0640 /etc/claudestruct/env` |
| `Cannot create database file` on first start | StateDirectory missing | Re-run `useradd … --create-home`; systemd creates `/var/lib/claudestruct` automatically when `StateDirectory=claudestruct` is honored |
| Caddy serves the right page locally but Tailscale Funnel returns 502 | Tailscale unaware of localhost binding | `sudo tailscale funnel 8787` (the daemon must already be on 127.0.0.1:8787) |
| GitHub webhook fires but lands on 401 | Wrong installation secret | Re-run `cs serve add-github-install …` and update the App settings to match |
| Worker is stuck on a single run | The LLM call is taking longer than `KillSignal` allows | Bump `TimeoutStopSec` in `claudestruct-worker.service`, or check the queue with `cs dashboard --json` |

## What's NOT in this recipe

- **Multiple hosts / Postgres failover**: jump to `deploy/helm/` instead.
- **Proper backup automation**: `tar` + cron is the bare minimum;
  serious teams want WAL streaming + encryption-at-rest.
- **Container-based runs (W8.3 follow-up)**: the worker still execs
  inline. Per-run Docker isolation lands separately.
- **Public-Internet hardening beyond Caddy**: WAF + DDoS protection
  are deployment-specific; the W8.x roadmap covers the SaaS posture.
