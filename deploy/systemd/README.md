# systemd units

Drop-in service files for running the long-lived claudestruct surfaces
on a Linux host (Asus GX10, NUC, VPS, …). See
[`docs/home-server.md`](../../docs/home-server.md) for the full setup
walkthrough.

| Unit                              | What                                              | Default port      |
|-----------------------------------|---------------------------------------------------|-------------------|
| `claudestruct.service`            | HTTP API (`cs serve run`)                         | `127.0.0.1:8787`  |
| `claudestruct-worker.service`     | Background worker (`cs serve worker`)             | n/a (DB consumer) |
| `claw-squad.service`              | claw-squad dashboard / Web UI                     | `127.0.0.1:8788`  |

All three units bind to localhost — the assumption is that a reverse
proxy (Caddy, nginx, Tailscale Funnel) terminates TLS and exposes
selected paths. Don't bind `0.0.0.0` directly; nothing here speaks
TLS natively.

## Quick install

```bash
sudo useradd -r -s /usr/sbin/nologin -d /var/lib/claudestruct claudestruct
sudo install -d -o claudestruct -g claudestruct /var/lib/claudestruct

sudo cp deploy/systemd/claudestruct.service           /etc/systemd/system/
sudo cp deploy/systemd/claudestruct-worker.service    /etc/systemd/system/

sudo install -d /etc/claudestruct
sudo install -m 0640 -o root -g claudestruct /dev/null /etc/claudestruct/claudestruct.env
# edit /etc/claudestruct/claudestruct.env to set ANTHROPIC_API_KEY etc.

sudo systemctl daemon-reload
sudo systemctl enable --now claudestruct.service claudestruct-worker.service
```

The `claw-squad.service` unit assumes node + a built `claw-squad` checkout
at `/opt/claw-squad`; tweak `ExecStart` for your install path.
