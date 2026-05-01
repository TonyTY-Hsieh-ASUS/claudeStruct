# Nightly code-health watchdog

Wires a `cs review` pass on the last N commits of a branch into a
systemd timer so `cs dashboard` always shows fresh quality data without
anyone clicking buttons. Pairs with the always-on deploy from
[`home-server.md`](home-server.md) — without that, the timer fires but
nothing aggregates the results.

## What it does

`scripts/nightly-review.sh` walks `git rev-list --max-count=N origin/<branch>`
backwards from HEAD and for each commit:

1. Detaches HEAD onto the commit.
2. `git reset --soft <parent>` so the working tree carries only that commit's diff.
3. Runs `cs review --redact --log-json <run-log>` so the structured
   JSONL output lands under `.claudestruct/runs/`.
4. Resets back to the commit and continues.

The commit walk runs in a single shot; per-commit failures are logged
but do not abort the loop (one bad merge with no diff context shouldn't
poison the whole night's data).

## Configuration

Environment variables (set via the systemd `EnvironmentFile=` or a
drop-in override):

| Var                  | Default                                  | Meaning                                      |
|----------------------|------------------------------------------|----------------------------------------------|
| `CS_NIGHTLY_REPO`    | *(required)*                             | Path to the working tree to review           |
| `CS_NIGHTLY_BRANCH`  | `main`                                   | Branch to walk                               |
| `CS_NIGHTLY_DEPTH`   | `3`                                      | Number of recent commits                     |
| `CS_NIGHTLY_LOG_DIR` | `$CS_NIGHTLY_REPO/.claudestruct/runs`    | Output directory                             |
| `ANTHROPIC_API_KEY`  | *(required)*                             | Same key the daytime services use            |

## Install

```bash
# Drop the script somewhere on PATH the systemd unit can find.
sudo install -m 0755 scripts/nightly-review.sh /usr/local/bin/

# Service + timer.
sudo cp deploy/systemd/claudestruct-nightly.service /etc/systemd/system/
sudo cp deploy/systemd/claudestruct-nightly.timer   /etc/systemd/system/

# Optional drop-in to override repo / branch / depth.
sudo install -d /etc/systemd/system/claudestruct-nightly.service.d
sudoedit /etc/systemd/system/claudestruct-nightly.service.d/override.conf
# Example contents:
#   [Service]
#   Environment=CS_NIGHTLY_REPO=/var/lib/claudestruct/myrepo
#   Environment=CS_NIGHTLY_DEPTH=5

sudo systemctl daemon-reload
sudo systemctl enable --now claudestruct-nightly.timer
systemctl list-timers claudestruct-nightly.timer
```

`Persistent=true` in the timer means a host that was off at 03:00 fires
the missed run on next boot — the dashboard trail stays unbroken across
power cycles.

## cron alternative

If you don't run systemd:

```cron
0 3 * * *  CS_NIGHTLY_REPO=/var/lib/claudestruct/myrepo /usr/local/bin/nightly-review.sh
```

The script is idempotent: per-run logs include a UTC timestamp in the
filename so multiple invocations on the same day don't collide.

## Reading the results

Morning routine:

```bash
cs dashboard --root /var/lib/claudestruct/myrepo --limit 20
```

Filter by the `nightly-` prefix in the run-id column to see only the
watchdog's runs versus interactive `cs review` calls. The Wave 6.5
cost-regression alerts already consume this stream — a run-cost spike
across the nightly logs triggers the same alert path daytime calls do.

## Why a wrapper script (not just a cron one-liner)

Two problems with `cs review --root /repo` from cron directly:

1. `cs review` reviews the *current* working-tree diff. Without the
   detach-and-soft-reset dance, the cron user reviews whatever is
   pending right now — usually nothing on a server that doesn't edit.
2. We want N commits, not just the latest, and per-commit logs so the
   dashboard can rank "biggest review-finding spike since when".

`nightly-review.sh` bundles both. It's small enough to read end-to-end
and adjusts cleanly to alternative review subcommands (e.g. swap
`cs review` for a `cs debug` invocation pointed at the test suite).
