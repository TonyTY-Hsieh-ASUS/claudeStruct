"""``cs serve`` CLI subcommand group.

Entry point lazy-imports FastAPI/uvicorn so the lean install (no
``[server]`` extra) doesn't pay for them on cold start of the
non-server CLI commands.

Subcommands:
    cs serve run           -- launch the HTTP API
    cs serve init-db       -- create tables (idempotent)
    cs serve add-org       -- create an org
    cs serve add-user      -- create a user + membership
    cs serve add-key       -- mint an API key (printed once)
"""
from __future__ import annotations

from typing import Any

import click


def _ensure_server_deps() -> None:
    try:
        import fastapi  # noqa: F401
        import sqlalchemy  # noqa: F401
        import uvicorn  # noqa: F401
    except ImportError as exc:
        raise click.ClickException(
            "The `cs serve` subcommand needs the [server] extra:\n"
            "  pip install 'claudestruct[server]'"
        ) from exc


@click.group("serve", help="Daemon-mode HTTP API + RBAC (W6.2 + W6.3).")
def serve_group() -> None:
    pass


@serve_group.command("run", help="Launch the HTTP API via uvicorn.")
@click.option("--host", default="127.0.0.1", show_default=True,
              help="Bind host. Use 0.0.0.0 to expose on the network.")
@click.option("--port", type=int, default=8787, show_default=True)
@click.option("--db-url", default=None,
              envvar="CLAUDESTRUCT_DATABASE_URL",
              help="SQLAlchemy URL. Default: sqlite:///./.claudestruct/server.db.")
@click.option("--run-root", type=click.Path(file_okay=False), default=".",
              show_default=True,
              help="Directory whose .claudestruct/runs/ feeds the dashboard.")
def serve_run(host: str, port: int, db_url: str | None, run_root: str) -> None:
    _ensure_server_deps()
    import uvicorn

    from claudestruct.server.app import create_app

    app = create_app(db_url=db_url, run_root=run_root)
    uvicorn.run(app, host=host, port=port, log_level="info")


@serve_group.command("init-db", help="Create tables (idempotent).")
@click.option("--db-url", default=None,
              envvar="CLAUDESTRUCT_DATABASE_URL")
def serve_init_db(db_url: str | None) -> None:
    _ensure_server_deps()
    from claudestruct.server.db import init_db, make_engine

    engine = make_engine(db_url)
    init_db(engine)
    click.echo(f"initialized {engine.url}")


@serve_group.command("add-org", help="Create a new org.")
@click.argument("slug")
@click.argument("name")
@click.option("--db-url", default=None, envvar="CLAUDESTRUCT_DATABASE_URL")
def serve_add_org(slug: str, name: str, db_url: str | None) -> None:
    _ensure_server_deps()
    from claudestruct.server.db import init_db, make_engine, make_session_factory
    from claudestruct.server.models import Org

    engine = make_engine(db_url)
    init_db(engine)
    factory = make_session_factory(engine)
    with factory() as session:
        org = Org(slug=slug, name=name)
        session.add(org)
        session.commit()
        session.refresh(org)
        click.echo(f"created org id={org.id} slug={org.slug}")


@serve_group.command("add-user", help="Create a user + add to an org with a role.")
@click.argument("email")
@click.argument("org_slug")
@click.option("--name", default=None)
@click.option("--role", type=click.Choice(["admin", "member", "viewer"]),
              default="member", show_default=True)
@click.option("--db-url", default=None, envvar="CLAUDESTRUCT_DATABASE_URL")
def serve_add_user(email: str, org_slug: str, name: str | None, role: str,
                   db_url: str | None) -> None:
    _ensure_server_deps()
    from sqlalchemy import select

    from claudestruct.server.db import init_db, make_engine, make_session_factory
    from claudestruct.server.models import Membership, Org, User

    engine = make_engine(db_url)
    init_db(engine)
    factory = make_session_factory(engine)
    with factory() as session:
        org = session.execute(
            select(Org).where(Org.slug == org_slug)
        ).scalar_one_or_none()
        if org is None:
            raise click.ClickException(f"org '{org_slug}' not found; run `cs serve add-org` first.")
        user = session.execute(
            select(User).where(User.email == email)
        ).scalar_one_or_none()
        if user is None:
            user = User(email=email, name=name)
            session.add(user)
            session.flush()
        membership = session.execute(
            select(Membership).where(
                Membership.user_id == user.id, Membership.org_id == org.id,
            )
        ).scalar_one_or_none()
        if membership is None:
            membership = Membership(user_id=user.id, org_id=org.id, role=role)
            session.add(membership)
        else:
            membership.role = role
        session.commit()
        click.echo(f"user id={user.id} email={user.email} role={role} org={org.slug}")


@serve_group.command("add-key", help="Mint an API key for a user in an org.")
@click.argument("email")
@click.argument("org_slug")
@click.option("--name", default=None, help="Human label (e.g. 'CI runner').")
@click.option("--db-url", default=None, envvar="CLAUDESTRUCT_DATABASE_URL")
def serve_add_key(email: str, org_slug: str, name: str | None,
                  db_url: str | None) -> None:
    _ensure_server_deps()
    from sqlalchemy import select

    from claudestruct.server.auth import generate_key
    from claudestruct.server.db import init_db, make_engine, make_session_factory
    from claudestruct.server.models import ApiKey, Membership, Org, User

    engine = make_engine(db_url)
    init_db(engine)
    factory = make_session_factory(engine)
    with factory() as session:
        org = session.execute(
            select(Org).where(Org.slug == org_slug)
        ).scalar_one_or_none()
        if org is None:
            raise click.ClickException(f"org '{org_slug}' not found.")
        user = session.execute(
            select(User).where(User.email == email)
        ).scalar_one_or_none()
        if user is None:
            raise click.ClickException(f"user '{email}' not found.")
        membership = session.execute(
            select(Membership).where(
                Membership.user_id == user.id, Membership.org_id == org.id,
            )
        ).scalar_one_or_none()
        if membership is None:
            raise click.ClickException(
                f"user '{email}' is not a member of '{org_slug}'."
            )
        full_key, key_id, hashed = generate_key()
        row = ApiKey(
            user_id=user.id, org_id=org.id,
            key_id=key_id, hashed_secret=hashed, name=name,
        )
        session.add(row)
        session.commit()
        click.echo(f"key_id={key_id}")
        click.echo(f"full_key={full_key}")
        click.echo("Store the full_key now; it cannot be retrieved later.")


@serve_group.command("add-github-install",
                     help="Register a GitHub App installation (W6.6).")
@click.argument("installation_id", type=int)
@click.argument("org_slug")
@click.option("--secret", default=None,
              help="Webhook secret. Auto-generated if omitted; printed once.")
@click.option("--repo-filter", default=None,
              help="Optional case-insensitive substring filter on owner/name.")
@click.option("--db-url", default=None, envvar="CLAUDESTRUCT_DATABASE_URL")
def serve_add_github_install(
    installation_id: int,
    org_slug: str,
    secret: str | None,
    repo_filter: str | None,
    db_url: str | None,
) -> None:
    """Map a GitHub App installation_id to a local org.

    Creates (or reuses) a sentinel `github-bot@<slug>.invalid` user
    that webhook-driven runs are attributed to, so the team
    dashboard's leaderboard surfaces them as a bot rather than
    crediting / blaming a real engineer.
    """
    _ensure_server_deps()
    import secrets as _secrets

    from sqlalchemy import select

    from claudestruct.server.db import init_db, make_engine, make_session_factory
    from claudestruct.server.models import (
        GitHubInstallation,
        Membership,
        Org,
        Role,
        User,
    )

    engine = make_engine(db_url)
    init_db(engine)
    factory = make_session_factory(engine)

    with factory() as session:
        org = session.execute(
            select(Org).where(Org.slug == org_slug)
        ).scalar_one_or_none()
        if org is None:
            raise click.ClickException(f"org '{org_slug}' not found.")

        existing = session.execute(
            select(GitHubInstallation).where(
                GitHubInstallation.installation_id == installation_id
            )
        ).scalar_one_or_none()
        if existing is not None and existing.is_active():
            raise click.ClickException(
                f"installation_id={installation_id} already registered for org_id={existing.org_id}"
            )

        bot_email = f"github-bot@{org_slug}.invalid"
        bot = session.execute(
            select(User).where(User.email == bot_email)
        ).scalar_one_or_none()
        if bot is None:
            bot = User(email=bot_email, name=f"GitHub bot ({org_slug})")
            session.add(bot)
            session.flush()
            session.add(Membership(
                user_id=bot.id, org_id=org.id, role=Role.member.value,
            ))

        webhook_secret = secret or _secrets.token_urlsafe(32)
        row = GitHubInstallation(
            installation_id=installation_id,
            org_id=org.id,
            webhook_secret=webhook_secret,
            repo_filter=repo_filter,
            bot_user_id=bot.id,
        )
        session.add(row)
        session.commit()
        click.echo(f"installation_id={installation_id} → org={org_slug}")
        click.echo(f"webhook_secret={webhook_secret}")
        click.echo("Paste this secret into the GitHub App settings as the Webhook secret.")


@serve_group.command("worker", help="Run the daemon-mode background worker (W6.1).")
@click.option("--db-url", default=None, envvar="CLAUDESTRUCT_DATABASE_URL")
@click.option("--run-root", type=click.Path(file_okay=False), default=".",
              show_default=True)
@click.option("--once", is_flag=True,
              help="Drain the queue once and exit; useful for cron / batch.")
@click.option("--poll-interval", type=float, default=1.0, show_default=True,
              help="Seconds to sleep when the queue is empty (long-running mode).")
def serve_worker(db_url: str | None, run_root: str, once: bool,
                 poll_interval: float) -> None:
    """Drain queued runs.

    Without `--once`, runs forever as a daemon, blocking on the queue
    when empty. With `--once`, drains everything currently queued and
    exits — call from cron / a CI step / a Kubernetes Job.
    """
    _ensure_server_deps()
    from claudestruct.server.db import init_db, make_engine, make_session_factory
    from claudestruct.server.worker import WorkerThread, drain_queue

    engine = make_engine(db_url)
    init_db(engine)
    factory = make_session_factory(engine)

    if once:
        n = drain_queue(factory, run_root)
        click.echo(f"drained {n} run(s)")
        return

    thread = WorkerThread(
        run_root=run_root,
        session_factory=factory,
        poll_interval_s=poll_interval,
    )
    click.echo(f"worker started (poll {poll_interval}s); Ctrl-C to stop")
    thread.start()
    try:
        # Block the foreground until the user interrupts. The worker
        # thread is daemon so a hard kill won't leak it; the SIGINT
        # path below is for graceful drain.
        thread._thread.join() if thread._thread else None  # noqa: SLF001
    except KeyboardInterrupt:
        click.echo("\nstopping worker (will finish in-flight run)…")
        thread.stop()
        click.echo("worker stopped")


@serve_group.command("alerts")
@click.option("--db-url", default=None, envvar="CLAUDESTRUCT_DATABASE_URL")
@click.option("--sigma", type=float, default=2.0, show_default=True,
              help="Trigger threshold: cost > N standard deviations above org mean.")
@click.option("--lookback-days", type=int, default=30, show_default=True,
              help="Baseline window for the mean+stddev calculation.")
@click.option("--check-recent-hours", type=int, default=24, show_default=True,
              help="Window of recent runs to evaluate against the baseline.")
def serve_alerts(db_url: str | None, sigma: float, lookback_days: int,
                 check_recent_hours: int) -> None:
    """Compute cost-regression alerts and dispatch via the notifier (W6.5).

    Provider is picked via ``CLAUDESTRUCT_NOTIFY_PROVIDER`` (``log`` by
    default; set to ``slack`` + ``CLAUDESTRUCT_SLACK_WEBHOOK_URL`` for
    Slack delivery). Findings flag runs whose cost is more than
    ``--sigma`` standard deviations above their org's 30-day mean
    successful-run cost. Run from cron / a Kubernetes CronJob.
    """
    _ensure_server_deps()
    from claudestruct.server.alerts import (
        compute_cost_regression_alerts,
        dispatch_findings,
    )
    from claudestruct.server.db import init_db, make_engine, make_session_factory
    from claudestruct.server.notify import default_notifier

    engine = make_engine(db_url)
    init_db(engine)
    factory = make_session_factory(engine)

    try:
        notifier = default_notifier()
    except RuntimeError as exc:
        # Misconfigured provider should be a loud, actionable failure
        # (cron job alerting on its own setup), not a silent skip.
        raise click.ClickException(str(exc)) from exc

    with factory() as session:
        findings = compute_cost_regression_alerts(
            session,
            sigma=sigma,
            lookback_days=lookback_days,
            check_recent_hours=check_recent_hours,
        )
        n = dispatch_findings(findings, notifier)
    click.echo(f"alerts: {n} dispatched via {notifier.name}")


def attach_to(main: Any) -> None:
    """Mount the serve subcommand group on the top-level CLI. Called
    from ``claudestruct.cli`` so the import stays optional."""
    main.add_command(serve_group)
