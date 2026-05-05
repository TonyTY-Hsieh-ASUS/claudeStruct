# Always-on home / company control plane

This guide walks through running `claudestruct` (HTTP API + worker) and
optionally the `claw-squad` Web UI as 24/7 services on a Linux host —
typically an Asus GX10, NUC, or always-on workstation. Output: a private
control plane reachable from your laptop or phone without exposing the
machine publicly.

The multi-tenant scaffolding from Waves 6–8 (orgs, API keys, GitHub-App
webhook handler, cost-regression alerts, SLO endpoint) only earns its
keep when there's a daemon listening — that's what this doc sets up.

## Prerequisites

- Linux host with `systemd` (Ubuntu 22.04+, Debian 12+, Fedora 39+ verified).
- Python 3.10+ with `pip install 'claudestruct[server]'` available system-wide.
- (Optional) Tailscale account for private-network access.
- (Optional) Caddy 2 if you want public HTTPS endpoints (e.g. for the
  GitHub-App webhook).

> Don't expose the API to the public internet directly: nothing in the
> bundled stack speaks TLS, and the auth surface assumes a trusted
> reverse proxy. Either keep it on a Tailscale tailnet (recommended for
> personal use) or front it with Caddy + a real cert.

## 1. Install the binaries

```bash
# system-wide install so the systemd unit can find /usr/local/bin/cs
sudo pip install --upgrade 'claudestruct[server]'
which cs   # should print /usr/local/bin/cs
```

If you prefer pipx for isolation:

```bash
sudo pipx install --global 'claudestruct[server]'
```

## 2. Create the service user + data dir

```bash
sudo useradd -r -s /usr/sbin/nologin -d /var/lib/claudestruct claudestruct
sudo install -d -o claudestruct -g claudestruct /var/lib/claudestruct
```

The worker writes runs to `/var/lib/claudestruct/.claudestruct/runs/`
and the SQLite DB to `/var/lib/claudestruct/server.db` by default.

## 3. Configure secrets

```bash
sudo install -d /etc/claudestruct
sudo install -m 0640 -o root -g claudestruct /dev/null /etc/claudestruct/claudestruct.env
sudoedit /etc/claudestruct/claudestruct.env
```

Minimum contents (this file is `EnvironmentFile=-` in the unit, so it's
optional but recommended):

```ini
ANTHROPIC_API_KEY=sk-ant-...
# Optional: pin a different DB if you'd rather use Postgres
# CLAUDESTRUCT_DATABASE_URL=postgresql+psycopg2://claudestruct@localhost/claudestruct
# Optional: GitHub App credentials (W6.6)
# CLAUDESTRUCT_GITHUB_APP_ID=12345
# CLAUDESTRUCT_GITHUB_APP_PRIVATE_KEY=/etc/claudestruct/github-app.pem
# CLAUDESTRUCT_GITHUB_WEBHOOK_SECRET=hex-string
```

Mode `0640` so root and the service user can read it but nothing else.

## 4. Install the systemd units

```bash
sudo cp deploy/systemd/claudestruct.service        /etc/systemd/system/
sudo cp deploy/systemd/claudestruct-worker.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now claudestruct.service claudestruct-worker.service

systemctl status claudestruct.service
systemctl status claudestruct-worker.service
```

`claudestruct.service` runs `cs serve init-db` as `ExecStartPre` so the
first boot is idempotent — no separate manual init step.

Verify:

```bash
curl -s http://127.0.0.1:8787/healthz
# => {"status":"ok"}
```

## 5. Bootstrap an org + API key

```bash
sudo -u claudestruct cs serve add-org default "Default Org"
sudo -u claudestruct cs serve add-user you@example.com default --role admin
sudo -u claudestruct cs serve add-key you@example.com default
# prints: cs_live_… — save it; only the last 4 chars are stored
```

## 6. Reverse proxy options

Pick one; you don't need both.

### 6a. Tailscale (recommended for personal / small-team use)

Install Tailscale, then expose the API on the tailnet only:

```bash
sudo tailscale up --ssh
sudo tailscale serve --bg --https=443 http://127.0.0.1:8787
# tailnet HTTPS terminates at the node; URL prints as https://<host>.<tailnet>.ts.net/
```

For inbound webhooks (GitHub App), enable Funnel on a single path:

```bash
sudo tailscale funnel --bg --https=443 \
  --set-path /v1/github/webhook \
  http://127.0.0.1:8787/v1/github/webhook
```

This exposes only the webhook path to the public internet; the rest of
the API stays tailnet-only.

### 6b. Caddy reverse proxy (custom domain)

`/etc/caddy/Caddyfile`:

```
claudestruct.example.com {
    encode gzip

    # GitHub webhook — public, signature-verified by the app handler.
    handle /v1/github/webhook {
        reverse_proxy 127.0.0.1:8787
    }

    # Everything else — private. Restrict by IP, basic auth, or your
    # auth proxy of choice (Authelia, oauth2-proxy, etc.).
    handle {
        @private remote_ip 100.0.0.0/8 192.168.0.0/16 10.0.0.0/8
        reverse_proxy @private 127.0.0.1:8787
        respond 403
    }
}
```

Caddy fetches Let's Encrypt certs automatically. Reload:

```bash
sudo systemctl reload caddy
```

## 7. (Optional) claw-squad Web UI

If you want collaborators to browse run history without ssh:

```bash
# Install claw-squad system-wide (one option among many):
sudo npm install -g claw-squad
sudo install -d -o clawsquad -g clawsquad /var/lib/claw-squad

sudo cp deploy/systemd/claw-squad.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now claw-squad.service
```

Adjust `ExecStart=/usr/bin/node /opt/claw-squad/dist/cli.js …` in the unit
to match where npm dropped the package (often
`/usr/lib/node_modules/claw-squad/dist/cli.js`).

Front it via Tailscale or Caddy on a separate path or vhost.

## 8. Logs and debugging

```bash
journalctl -u claudestruct.service -f
journalctl -u claudestruct-worker.service -f
journalctl -u claw-squad.service -f
```

The worker's structured run logs land under
`/var/lib/claudestruct/.claudestruct/runs/*.jsonl`; surface them via
`cs dashboard --root /var/lib/claudestruct` from your laptop over the
tailnet.

## 9. Updating

```bash
sudo pip install --upgrade 'claudestruct[server]'
sudo systemctl restart claudestruct.service claudestruct-worker.service
```

`init-db` is idempotent (and runs as `ExecStartPre`), so schema migrations
shipped with a release apply on the next restart.

## What this doesn't cover

- **High availability**: single host, single SQLite. Move to Postgres
  + a managed runner if you outgrow this.
- **Multiple workers**: the worker uses `SELECT … FOR UPDATE` against a
  single DB; running two `claudestruct-worker.service` instances against
  the same Postgres needs an external coordinator we don't ship.
- **TLS-on-loopback**: nothing here speaks TLS to localhost. The reverse
  proxy is the TLS boundary.

When any of these starts mattering, that's the signal to graduate from
the home-server setup to the Hosted SaaS architecture documented in
[server.md](server.md).
