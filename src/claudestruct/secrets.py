"""Pluggable secrets backend (W5.4).

Replaces the direct ``os.environ["ANTHROPIC_API_KEY"]`` read scattered
through the codebase with a small abstraction so operators can keep
their API key in:

- ``env`` (default; no extra deps)
- ``keyring`` (OS keychain — macOS Keychain, Linux Secret Service /
  Gnome Keyring / KWallet, Windows Credential Manager). Optional dep.
- ``pass`` (the standard Unix password manager). Calls out to the
  ``pass`` binary; no Python dep.
- ``file`` (read a path from disk; useful for ``$XDG_RUNTIME_DIR``
  ramfs or Docker secrets at ``/run/secrets/...``).

The provider is selected by ``CLAUDESTRUCT_SECRETS_PROVIDER`` (default
``env``). Each provider answers ``get(name) -> str | None`` for a
canonical secret name like ``anthropic.api_key``. Misses fall back to
the next provider (chain configured by the caller); the ``env`` chain
also accepts the legacy uppercase env-var name (``ANTHROPIC_API_KEY``)
so existing setups keep working.
"""
from __future__ import annotations

import os
import shutil
import subprocess
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol


class SecretsProvider(Protocol):
    """Read-only secrets backend. Returns ``None`` for misses (caller
    decides whether to fail or fall through to another provider)."""

    name: str

    def get(self, key: str) -> str | None: ...


# Canonical name -> uppercase env-var fallback. Lets users set
# ANTHROPIC_API_KEY without learning the new ``anthropic.api_key`` name.
_LEGACY_ENV_MAP = {
    "anthropic.api_key": "ANTHROPIC_API_KEY",
    "github.token": "GITHUB_TOKEN",
    "slack.bot_token": "SLACK_BOT_TOKEN",
    "slack.app_token": "SLACK_APP_TOKEN",
}


def _canonical_to_env(key: str) -> str:
    """Map ``anthropic.api_key`` to the env-var name a user would set
    (``CLAUDESTRUCT_SECRET_ANTHROPIC_API_KEY``)."""
    return "CLAUDESTRUCT_SECRET_" + key.upper().replace(".", "_")


@dataclass
class EnvProvider:
    """Reads from ``os.environ``. Two lookups per key:

    1. Canonical: ``CLAUDESTRUCT_SECRET_ANTHROPIC_API_KEY``
    2. Legacy: ``ANTHROPIC_API_KEY``

    The legacy fallback keeps every existing install working.
    """

    name: str = "env"

    def get(self, key: str) -> str | None:
        canonical = _canonical_to_env(key)
        if canonical in os.environ and os.environ[canonical]:
            return os.environ[canonical]
        legacy = _LEGACY_ENV_MAP.get(key)
        if legacy and legacy in os.environ and os.environ[legacy]:
            return os.environ[legacy]
        return None


@dataclass
class KeyringProvider:
    """Reads from the OS keychain via the ``keyring`` PyPI package.

    Service is hardcoded to ``claudestruct``; key is the canonical
    name. Set with::

        keyring set claudestruct anthropic.api_key

    The package import is lazy so users without ``keyring`` installed
    don't pay for it on cold start.
    """

    service: str = "claudestruct"
    name: str = "keyring"

    def get(self, key: str) -> str | None:
        try:
            import keyring  # type: ignore
        except ImportError:
            return None
        try:
            return keyring.get_password(self.service, key)
        except Exception:
            # keyring backends raise a zoo of unrelated errors when
            # the platform service is unavailable. Treat all as miss.
            return None


@dataclass
class PassProvider:
    """Reads from the Unix ``pass`` password manager.

    Looks up entries under the configurable ``prefix`` (default
    ``claudestruct/``) so a real ``pass`` store with personal items
    isn't shadowed.
    """

    prefix: str = "claudestruct"
    name: str = "pass"

    def get(self, key: str) -> str | None:
        binary = shutil.which("pass")
        if binary is None:
            return None
        path = f"{self.prefix}/{key}" if self.prefix else key
        try:
            res = subprocess.run(
                [binary, "show", path],
                capture_output=True,
                text=True,
                timeout=5,
            )
        except (OSError, subprocess.SubprocessError):
            return None
        if res.returncode != 0:
            return None
        # `pass` may emit a multi-line entry; the convention is the
        # first line is the secret and subsequent lines are metadata.
        first = res.stdout.partition("\n")[0].strip()
        return first or None


@dataclass
class FileProvider:
    """Reads from a directory of secret files.

    Designed for ``/run/secrets/<key>`` (Docker secrets) and
    ``$XDG_RUNTIME_DIR/claudestruct/<key>``. Trailing whitespace is
    stripped — a common gotcha with secrets shoveled in via shell
    redirects.
    """

    base: Path
    name: str = "file"

    def get(self, key: str) -> str | None:
        path = self.base / key.replace(".", "_")
        if not path.is_file():
            return None
        try:
            return path.read_text(encoding="utf-8").strip() or None
        except OSError:
            return None


# --- Public API -----------------------------------------------------

def default_chain() -> list[SecretsProvider]:
    """Build the provider chain selected by env.

    ``CLAUDESTRUCT_SECRETS_PROVIDER`` accepts a comma-separated list:
    ``env,keyring,pass,file:/run/secrets``. Order matters; first hit
    wins. Default: ``env`` only (back-compat).
    """
    raw = os.environ.get("CLAUDESTRUCT_SECRETS_PROVIDER", "env")
    chain: list[SecretsProvider] = []
    for part in [p.strip() for p in raw.split(",") if p.strip()]:
        if part == "env":
            chain.append(EnvProvider())
        elif part == "keyring":
            chain.append(KeyringProvider())
        elif part == "pass":
            chain.append(PassProvider())
        elif part.startswith("file:"):
            chain.append(FileProvider(base=Path(part[5:])))
        # Unknown providers are skipped silently — typos shouldn't
        # break a run that has the value in another provider.
    if not chain:
        chain.append(EnvProvider())
    return chain


def get(
    key: str,
    *,
    providers: Iterable[SecretsProvider] | None = None,
) -> str | None:
    """Look up a canonical secret name across the configured chain.

    Returns ``None`` only if every provider misses; the caller decides
    whether to fall back to a default or raise.
    """
    chain = list(providers) if providers is not None else default_chain()
    for p in chain:
        v = p.get(key)
        if v:
            return v
    return None


def require(
    key: str,
    *,
    providers: Iterable[SecretsProvider] | None = None,
) -> str:
    """Like :func:`get` but raises ``KeyError`` on miss with a message
    listing which providers were consulted (for actionable errors)."""
    chain = list(providers) if providers is not None else default_chain()
    for p in chain:
        v = p.get(key)
        if v:
            return v
    names = ", ".join(p.name for p in chain) or "<none>"
    raise KeyError(
        f"secret '{key}' not found in providers: {names}. "
        f"Set it via env (CLAUDESTRUCT_SECRET_{key.upper().replace('.', '_')}), "
        f"keyring, pass, or file."
    )
