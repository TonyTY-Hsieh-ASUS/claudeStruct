# systemd units (W10.2)

Single-host always-on deployment of the claudestruct daemon. Pairs
the W6.2 / W6.3 server scaffolding with real systemd hardening so
your team's GitHub webhooks, cost-regression alerts, and SLO
endpoint actually have somewhere to land 24/7.

## Files

| File | Purpose |
|---|---|
| `claudestruct.service` | API server (`cs serve run`). Bound to `127.0.0.1` by default. |
| `claudestruct-worker.service` | Background runner (`cs serve worker`). Drains queued `Run` rows. |
| `claudestruct.env.example` | Environment file template — provider creds, DB URL, region tag, optional caps + tracing + Sentry. |
| `Caddyfile.example` | Reverse-proxy snippet — Tailscale-fronted (recommended) or public + Let's Encrypt. |

## Full recipe

The 30-minute walkthrough lives in [`docs/home-server.md`](../../docs/home-server.md).
That includes Tailscale setup, the GitHub App wiring, backup notes,
and a troubleshooting cheat sheet.

## When to NOT use these

- **Multi-host / failover**: use `deploy/helm/` instead.
- **No always-on machine available**: the cs CLI works fine without
  the daemon — these units are only relevant once you want the
  REST API + webhook receivers running 24/7.

## Hardening notes

Both units carry a defense-in-depth set of `Protect*` /
`Restrict*` directives chosen so a typical claudestruct workload
(Anthropic SDK, Ollama HTTP client, SQLite, OTel exporter) still
works while the kernel surface area shrinks. Highlights:

- `ProtectSystem=strict` + `ProtectHome=read-only` — the daemon
  cannot write outside its `StateDirectory` / `RuntimeDirectory`.
- `RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6` — no AF_NETLINK
  for kernel-config probes; no AF_PACKET for raw-socket sniffing.
- `RestrictNamespaces=true` — even if the W10.9 sandbox tries to
  unshare, this unit specifically can't.
- `MemoryDenyWriteExecute=false` — kept on because tiktoken /
  numpy mmap need RWX. Flip to `true` once we verify upstream
  dropped that requirement.

If you're running through `claw-sandbox` for Coder calls (the W5.5
+ W10.9 path), those isolation layers stack on top of these
service-level protections.
