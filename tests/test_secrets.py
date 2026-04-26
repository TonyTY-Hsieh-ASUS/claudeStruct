"""Tests for the pluggable secrets backend (W5.4)."""
from __future__ import annotations

import pytest

from claudestruct import secrets

# --- EnvProvider ----------------------------------------------------

def test_env_provider_canonical_name(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.setenv("CLAUDESTRUCT_SECRET_ANTHROPIC_API_KEY", "sk-canon")
    p = secrets.EnvProvider()
    assert p.get("anthropic.api_key") == "sk-canon"


def test_env_provider_legacy_fallback(monkeypatch):
    monkeypatch.delenv("CLAUDESTRUCT_SECRET_ANTHROPIC_API_KEY", raising=False)
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-legacy")
    p = secrets.EnvProvider()
    assert p.get("anthropic.api_key") == "sk-legacy"


def test_env_provider_canonical_wins_over_legacy(monkeypatch):
    monkeypatch.setenv("CLAUDESTRUCT_SECRET_ANTHROPIC_API_KEY", "sk-canon")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-legacy")
    assert secrets.EnvProvider().get("anthropic.api_key") == "sk-canon"


def test_env_provider_miss_returns_none(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.delenv("CLAUDESTRUCT_SECRET_ANTHROPIC_API_KEY", raising=False)
    assert secrets.EnvProvider().get("anthropic.api_key") is None


def test_env_provider_empty_value_treated_as_miss(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "")
    assert secrets.EnvProvider().get("anthropic.api_key") is None


def test_env_provider_unknown_canonical_no_legacy(monkeypatch):
    # A canonical name with no legacy mapping: only the canonical
    # env-var path is consulted.
    monkeypatch.delenv("CLAUDESTRUCT_SECRET_FOO_BAR", raising=False)
    assert secrets.EnvProvider().get("foo.bar") is None


# --- KeyringProvider ------------------------------------------------

def test_keyring_provider_no_module_returns_none(monkeypatch):
    # Force ImportError by removing the module from sys.modules and
    # blocking the import.
    import sys
    sys.modules.pop("keyring", None)
    monkeypatch.setattr(
        "builtins.__import__",
        _raising_import("keyring", ImportError),
    )
    assert secrets.KeyringProvider().get("anthropic.api_key") is None


def _raising_import(blocked_name, exc_type):
    real = __import__

    def _imp(name, *args, **kwargs):
        if name == blocked_name:
            raise exc_type(name)
        return real(name, *args, **kwargs)
    return _imp


# --- FileProvider ---------------------------------------------------

def test_file_provider_reads_secret(tmp_path):
    (tmp_path / "anthropic_api_key").write_text("sk-from-file\n", encoding="utf-8")
    p = secrets.FileProvider(base=tmp_path)
    assert p.get("anthropic.api_key") == "sk-from-file"


def test_file_provider_strips_whitespace(tmp_path):
    (tmp_path / "anthropic_api_key").write_text("  sk-pad  \n\n", encoding="utf-8")
    assert secrets.FileProvider(base=tmp_path).get("anthropic.api_key") == "sk-pad"


def test_file_provider_missing_returns_none(tmp_path):
    assert secrets.FileProvider(base=tmp_path).get("anthropic.api_key") is None


def test_file_provider_empty_returns_none(tmp_path):
    (tmp_path / "anthropic_api_key").write_text("   \n", encoding="utf-8")
    assert secrets.FileProvider(base=tmp_path).get("anthropic.api_key") is None


# --- PassProvider ---------------------------------------------------

def test_pass_provider_no_binary(monkeypatch):
    monkeypatch.setattr("shutil.which", lambda _: None)
    assert secrets.PassProvider().get("anthropic.api_key") is None


def test_pass_provider_returns_first_line(monkeypatch):
    monkeypatch.setattr("shutil.which", lambda _: "/usr/bin/pass")

    class FakeRes:
        returncode = 0
        stdout = "sk-from-pass\nuser: alice\n"

    def fake_run(*args, **kwargs):
        return FakeRes()

    monkeypatch.setattr("subprocess.run", fake_run)
    assert secrets.PassProvider().get("anthropic.api_key") == "sk-from-pass"


def test_pass_provider_nonzero_exit_returns_none(monkeypatch):
    monkeypatch.setattr("shutil.which", lambda _: "/usr/bin/pass")

    class FakeRes:
        returncode = 1
        stdout = "Error: not found\n"

    monkeypatch.setattr("subprocess.run", lambda *a, **k: FakeRes())
    assert secrets.PassProvider().get("anthropic.api_key") is None


# --- default_chain --------------------------------------------------

def test_default_chain_env_only(monkeypatch):
    monkeypatch.delenv("CLAUDESTRUCT_SECRETS_PROVIDER", raising=False)
    chain = secrets.default_chain()
    assert [p.name for p in chain] == ["env"]


def test_default_chain_multiple(monkeypatch):
    monkeypatch.setenv("CLAUDESTRUCT_SECRETS_PROVIDER", "env,keyring,pass")
    names = [p.name for p in secrets.default_chain()]
    assert names == ["env", "keyring", "pass"]


def test_default_chain_with_file_path(monkeypatch, tmp_path):
    monkeypatch.setenv("CLAUDESTRUCT_SECRETS_PROVIDER", f"env,file:{tmp_path}")
    chain = secrets.default_chain()
    assert chain[1].name == "file"
    assert chain[1].base == tmp_path


def test_default_chain_unknown_provider_skipped(monkeypatch):
    monkeypatch.setenv("CLAUDESTRUCT_SECRETS_PROVIDER", "env,bogus,pass")
    names = [p.name for p in secrets.default_chain()]
    assert names == ["env", "pass"]


def test_default_chain_empty_falls_back_to_env(monkeypatch):
    monkeypatch.setenv("CLAUDESTRUCT_SECRETS_PROVIDER", "")
    assert [p.name for p in secrets.default_chain()] == ["env"]


# --- get / require --------------------------------------------------

def test_get_first_hit_wins():
    class P1:
        name = "p1"

        def get(self, key):
            return None

    class P2:
        name = "p2"

        def get(self, key):
            return "from-p2"

    class P3:
        name = "p3"

        def get(self, key):
            return "from-p3"

    assert secrets.get("k", providers=[P1(), P2(), P3()]) == "from-p2"


def test_get_all_miss_returns_none():
    class P:
        name = "p"

        def get(self, key):
            return None

    assert secrets.get("k", providers=[P()]) is None


def test_require_raises_with_consulted_providers():
    class P:
        name = "stub"

        def get(self, key):
            return None

    with pytest.raises(KeyError) as exc:
        secrets.require("anthropic.api_key", providers=[P()])
    msg = str(exc.value)
    assert "anthropic.api_key" in msg
    assert "stub" in msg


def test_require_returns_value_on_hit():
    class P:
        name = "stub"

        def get(self, key):
            return "ok"

    assert secrets.require("k", providers=[P()]) == "ok"


# --- client.py integration ------------------------------------------

def test_client_make_client_reads_via_secrets(monkeypatch):
    """`_make_client` should fail with ClaudestructError when no
    provider returns a key, and succeed otherwise."""
    from claudestruct import client as client_mod

    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.delenv("CLAUDESTRUCT_SECRET_ANTHROPIC_API_KEY", raising=False)
    monkeypatch.delenv("CLAUDESTRUCT_SECRETS_PROVIDER", raising=False)
    with pytest.raises(client_mod.ClaudestructError):
        client_mod._make_client()

    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
    c = client_mod._make_client()
    assert c is not None
