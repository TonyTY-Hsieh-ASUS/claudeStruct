"""Tests for the CMEK envelope-encryption module (W8.6)."""
from __future__ import annotations

import pytest

pytest.importorskip("cryptography")
pytest.importorskip("fastapi")  # crypto module is server-only

from claudestruct.server import crypto as crypto_mod


# --- LocalKMSProvider -----------------------------------------------

def test_local_kms_round_trip(monkeypatch):
    monkeypatch.setenv("CLAUDESTRUCT_KEK_PASSPHRASE", "correct horse battery staple")
    p = crypto_mod.LocalKMSProvider()
    dek = crypto_mod.fresh_dek()
    wrapped = p.wrap(dek)
    assert wrapped.provider == "local"
    assert wrapped.key_id == "local"
    assert p.unwrap(wrapped) == dek


def test_local_kms_two_passphrases_dont_share_keyspace():
    """Different passphrases must produce un-cross-decryptable wraps.
    Otherwise a passphrase rotation wouldn't actually rotate keys."""
    p1 = crypto_mod.LocalKMSProvider(_kek=crypto_mod._kek_from_passphrase("alpha"))
    p2 = crypto_mod.LocalKMSProvider(_kek=crypto_mod._kek_from_passphrase("beta"))
    dek = crypto_mod.fresh_dek()
    wrapped = p1.wrap(dek)
    with pytest.raises(crypto_mod.KMSError):
        p2.unwrap(wrapped)


def test_local_kms_rejects_wrong_dek_length():
    p = crypto_mod.LocalKMSProvider(_kek=b"\x00" * 32)
    with pytest.raises(crypto_mod.KMSError, match="32 bytes"):
        p.wrap(b"\x00" * 16)  # AES-128 key length, not what we want


def test_local_kms_rejects_truncated_blob():
    p = crypto_mod.LocalKMSProvider(_kek=b"\x00" * 32)
    bad = crypto_mod.WrappedDEK(provider="local", key_id="local", wrapped_bytes=b"\x00")
    with pytest.raises(crypto_mod.KMSError, match="too short"):
        p.unwrap(bad)


def test_local_kms_rejects_wrong_provider_blob():
    p = crypto_mod.LocalKMSProvider(_kek=b"\x00" * 32)
    bad = crypto_mod.WrappedDEK(provider="aws", key_id="arn:...", wrapped_bytes=b"\x00" * 32)
    with pytest.raises(crypto_mod.KMSError, match="provider mismatch"):
        p.unwrap(bad)


def test_local_kms_random_kek_means_restart_invalidates_wrap():
    """Sanity: when the env passphrase is unset, every fresh
    LocalKMSProvider has its own random KEK, and the previous wrap
    is no longer unwrappable. Documents the dev-only escape hatch."""
    p1 = crypto_mod.LocalKMSProvider()
    p2 = crypto_mod.LocalKMSProvider()  # different per-process random KEK
    dek = crypto_mod.fresh_dek()
    wrapped = p1.wrap(dek)
    with pytest.raises(crypto_mod.KMSError):
        p2.unwrap(wrapped)


# --- default_provider -----------------------------------------------

def test_default_provider_local_requires_passphrase(monkeypatch):
    monkeypatch.delenv("CLAUDESTRUCT_KEK_PASSPHRASE", raising=False)
    monkeypatch.delenv("CLAUDESTRUCT_KMS_PROVIDER", raising=False)
    with pytest.raises(crypto_mod.KMSError, match="KEK_PASSPHRASE"):
        crypto_mod.default_provider()


def test_default_provider_local_with_passphrase(monkeypatch):
    monkeypatch.setenv("CLAUDESTRUCT_KEK_PASSPHRASE", "x" * 32)
    p = crypto_mod.default_provider()
    assert p.name == "local"


def test_default_provider_allow_random_kek_skips_check(monkeypatch):
    monkeypatch.delenv("CLAUDESTRUCT_KEK_PASSPHRASE", raising=False)
    p = crypto_mod.default_provider(allow_random_kek=True)
    assert p.name == "local"


def test_default_provider_aws_not_yet_implemented(monkeypatch):
    monkeypatch.setenv("CLAUDESTRUCT_KMS_PROVIDER", "aws")
    with pytest.raises(NotImplementedError, match="AWS"):
        crypto_mod.default_provider()


def test_default_provider_unknown_name_raises(monkeypatch):
    monkeypatch.setenv("CLAUDESTRUCT_KMS_PROVIDER", "bogus")
    with pytest.raises(crypto_mod.KMSError, match="unknown"):
        crypto_mod.default_provider()


# --- Field-level helpers --------------------------------------------

def test_encrypt_decrypt_round_trip():
    dek = crypto_mod.fresh_dek()
    plaintext = b"the quick brown fox"
    blob = crypto_mod.encrypt_field(dek, plaintext, aad=b"users.email|42")
    assert blob != plaintext
    assert crypto_mod.decrypt_field(dek, blob, aad=b"users.email|42") == plaintext


def test_encrypt_two_calls_produce_different_ciphertext():
    """Random nonces -> two encryptions of the same plaintext under
    the same DEK must not collide. Otherwise an observer could correlate."""
    dek = crypto_mod.fresh_dek()
    a = crypto_mod.encrypt_field(dek, b"same input")
    b = crypto_mod.encrypt_field(dek, b"same input")
    assert a != b


def test_decrypt_with_wrong_aad_fails():
    """AAD-bound row identity: a blob originally written for one row
    must fail decryption when presented under another row's AAD."""
    dek = crypto_mod.fresh_dek()
    blob = crypto_mod.encrypt_field(dek, b"secret", aad=b"users.email|42")
    with pytest.raises(crypto_mod.KMSError, match="auth failed"):
        crypto_mod.decrypt_field(dek, blob, aad=b"users.email|99")


def test_decrypt_with_wrong_dek_fails():
    blob = crypto_mod.encrypt_field(crypto_mod.fresh_dek(), b"secret")
    with pytest.raises(crypto_mod.KMSError, match="auth failed"):
        crypto_mod.decrypt_field(crypto_mod.fresh_dek(), blob)


def test_decrypt_truncated_blob_fails():
    dek = crypto_mod.fresh_dek()
    with pytest.raises(crypto_mod.KMSError, match="too short"):
        crypto_mod.decrypt_field(dek, b"\x00" * 5)


def test_encrypt_field_rejects_wrong_dek_length():
    with pytest.raises(crypto_mod.KMSError, match="32 bytes"):
        crypto_mod.encrypt_field(b"\x00" * 16, b"hi")


# --- base64 helpers -------------------------------------------------

def test_b64_round_trip():
    for sample in [b"", b"\x00", b"\x00\x01\x02", b"hello world"]:
        assert crypto_mod.decode_b64(crypto_mod.encode_b64(sample)) == sample


def test_b64_url_safe_no_padding():
    """Ensure the encoder doesn't emit ``=`` padding -- it'd break
    URL-safe contexts and DB column round-trips that strip whitespace."""
    blob = b"\xff" * 31  # length that would normally pad
    assert "=" not in crypto_mod.encode_b64(blob)
