"""Tests for the GitHub App outbound helpers (W6.6 follow-up)."""
from __future__ import annotations

import base64
import json
from datetime import datetime, timedelta, timezone

import pytest

pytest.importorskip("cryptography")
pytest.importorskip("fastapi")

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa

from claudestruct.server import github_app as gha

# --- Fixtures -------------------------------------------------------


@pytest.fixture(scope="module")
def rsa_keypair():
    """Generate a single RSA-2048 keypair shared across the module's
    tests. Generation is slow (~250ms) so module-scoped fixture pays
    that once instead of per-test."""
    priv = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    priv_pem = priv.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    )
    pub = priv.public_key()
    return {"private_pem": priv_pem, "public_key": pub, "private_key": priv}


# --- Stubs ----------------------------------------------------------


class _Resp:
    def __init__(self, status_code: int, payload: dict):
        self.status_code = status_code
        self._payload = payload

    def json(self):
        return self._payload


class _StubHttpClient:
    """Records POSTs; returns a per-test scripted response."""

    def __init__(self, response: _Resp):
        self.response = response
        self.calls: list[tuple[str, dict]] = []

    def post(self, url, **kw):
        self.calls.append((url, kw))
        return self.response

    def close(self):
        pass


# --- load_app_config ------------------------------------------------


def test_load_app_config_returns_none_when_unset(monkeypatch):
    monkeypatch.delenv("CLAUDESTRUCT_GITHUB_APP_ID", raising=False)
    monkeypatch.delenv("CLAUDESTRUCT_GITHUB_APP_PRIVATE_KEY_PEM", raising=False)
    assert gha.load_app_config() is None


def test_load_app_config_reads_env(monkeypatch, rsa_keypair):
    monkeypatch.setenv("CLAUDESTRUCT_GITHUB_APP_ID", "12345")
    monkeypatch.setenv(
        "CLAUDESTRUCT_GITHUB_APP_PRIVATE_KEY_PEM",
        rsa_keypair["private_pem"].decode("utf-8"),
    )
    cfg = gha.load_app_config()
    assert cfg is not None
    assert cfg.app_id == "12345"
    assert b"BEGIN PRIVATE KEY" in cfg.private_key_pem


def test_load_app_config_returns_none_when_only_id_set(monkeypatch):
    """Half-configured deployments must fail closed."""
    monkeypatch.setenv("CLAUDESTRUCT_GITHUB_APP_ID", "12345")
    monkeypatch.delenv("CLAUDESTRUCT_GITHUB_APP_PRIVATE_KEY_PEM", raising=False)
    assert gha.load_app_config() is None


# --- mint_app_jwt ---------------------------------------------------


def _decode_jwt_payload(jwt: str) -> dict:
    """Best-effort decode of the JWT body (no signature verify). Used
    by tests to inspect claims."""
    _, body, _ = jwt.split(".")
    pad = "=" * (-len(body) % 4)
    return json.loads(base64.urlsafe_b64decode(body + pad))


def test_mint_app_jwt_has_three_segments(rsa_keypair):
    jwt = gha.mint_app_jwt(
        app_id="42", private_key_pem=rsa_keypair["private_pem"],
    )
    assert jwt.count(".") == 2


def test_mint_app_jwt_claims_have_expected_fields(rsa_keypair):
    now = datetime(2026, 4, 28, 12, 0, tzinfo=timezone.utc)
    jwt = gha.mint_app_jwt(
        app_id="42", private_key_pem=rsa_keypair["private_pem"], now=now,
    )
    claims = _decode_jwt_payload(jwt)
    assert claims["iss"] == "42"
    # iat should be 30s in the past per the helper's drift buffer.
    assert claims["iat"] == int(now.timestamp()) - 30
    # exp should be 540s in the future (under GitHub's 600s cap).
    assert claims["exp"] == int(now.timestamp()) + 540
    # Sanity: exp - iat ≤ 600 to satisfy GitHub.
    assert claims["exp"] - claims["iat"] <= 600


def test_mint_app_jwt_signature_verifies_with_public_key(rsa_keypair):
    """End-to-end: a downstream verifier with our public key must
    accept the signature. Demonstrates we're producing a *real*
    RS256 JWT, not just a base64-shaped blob."""
    jwt = gha.mint_app_jwt(
        app_id="42", private_key_pem=rsa_keypair["private_pem"],
    )
    header_b64, body_b64, sig_b64 = jwt.split(".")
    signing_input = f"{header_b64}.{body_b64}".encode("ascii")
    pad = "=" * (-len(sig_b64) % 4)
    sig = base64.urlsafe_b64decode(sig_b64 + pad)

    rsa_keypair["public_key"].verify(
        sig,
        signing_input,
        padding.PKCS1v15(),
        hashes.SHA256(),
    )  # raises on failure


def test_mint_app_jwt_rejects_non_rsa_key():
    """An EC or DSA key must fail loudly so an operator notices their
    misconfiguration before GitHub does."""
    from cryptography.hazmat.primitives.asymmetric import ec
    ec_key = ec.generate_private_key(ec.SECP256R1())
    pem = ec_key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    )
    with pytest.raises(gha.GitHubAppError, match="must be RSA"):
        gha.mint_app_jwt(app_id="42", private_key_pem=pem)


def test_mint_app_jwt_rejects_garbage_pem():
    with pytest.raises(gha.GitHubAppError, match="could not load"):
        gha.mint_app_jwt(app_id="42", private_key_pem=b"not a key")


# --- mint_installation_token ----------------------------------------


def test_mint_installation_token_parses_response():
    expires = "2026-04-28T13:00:00Z"
    client = _StubHttpClient(_Resp(201, {"token": "ghs_x", "expires_at": expires}))
    tok = gha.mint_installation_token(
        installation_id=99, app_jwt="jwt", http_client=client,
    )
    assert tok.token == "ghs_x"
    assert tok.expires_at.isoformat() == "2026-04-28T13:00:00+00:00"
    assert client.calls[0][0].endswith("/app/installations/99/access_tokens")
    assert client.calls[0][1]["headers"]["Authorization"] == "Bearer jwt"


def test_mint_installation_token_raises_on_non_201():
    client = _StubHttpClient(_Resp(401, {"message": "bad jwt"}))
    with pytest.raises(gha.GitHubAppError, match="status=401"):
        gha.mint_installation_token(
            installation_id=99, app_jwt="bad", http_client=client,
        )


def test_mint_installation_token_raises_on_missing_fields():
    client = _StubHttpClient(_Resp(201, {"token": "x"}))  # no expires_at
    with pytest.raises(gha.GitHubAppError, match="missing fields"):
        gha.mint_installation_token(
            installation_id=99, app_jwt="jwt", http_client=client,
        )


# --- InstallationTokenCache -----------------------------------------


def _provider_returning(jwt: str):
    """Helper to build a zero-arg jwt-provider callable that records
    how many times it was invoked."""
    state = {"calls": 0}

    def _p() -> str:
        state["calls"] += 1
        return jwt

    _p.state = state  # type: ignore[attr-defined]
    return _p


def test_cache_mints_then_reuses_within_freshness_window():
    """Second call with the same installation_id must NOT mint again."""
    expires = (
        datetime.now(timezone.utc) + timedelta(minutes=30)
    ).isoformat().replace("+00:00", "Z")
    client = _StubHttpClient(_Resp(201, {"token": "tok-1", "expires_at": expires}))
    provider = _provider_returning("jwt")
    cache = gha.InstallationTokenCache()

    a = cache.get(installation_id=1, app_jwt_provider=provider, http_client=client)
    b = cache.get(installation_id=1, app_jwt_provider=provider, http_client=client)
    assert a is b
    assert provider.state["calls"] == 1  # second get reused cached


def test_cache_refreshes_when_token_about_to_expire():
    """When less than REFRESH_BUFFER remains, a new token is minted."""
    # First call: token expiring in 1 minute (< 5 min buffer → must refresh).
    expires_soon = (
        datetime.now(timezone.utc) + timedelta(minutes=1)
    ).isoformat().replace("+00:00", "Z")
    expires_long = (
        datetime.now(timezone.utc) + timedelta(minutes=55)
    ).isoformat().replace("+00:00", "Z")

    responses = [
        _Resp(201, {"token": "tok-1", "expires_at": expires_soon}),
        _Resp(201, {"token": "tok-2", "expires_at": expires_long}),
    ]
    client = _StubHttpClient(responses[0])
    provider = _provider_returning("jwt")
    cache = gha.InstallationTokenCache()

    a = cache.get(installation_id=1, app_jwt_provider=provider, http_client=client)
    assert a.token == "tok-1"
    # Hot-swap response for the refresh request.
    client.response = responses[1]
    b = cache.get(installation_id=1, app_jwt_provider=provider, http_client=client)
    assert b.token == "tok-2"
    assert provider.state["calls"] == 2


def test_cache_invalidate_forces_refresh():
    expires = (
        datetime.now(timezone.utc) + timedelta(minutes=30)
    ).isoformat().replace("+00:00", "Z")
    client = _StubHttpClient(_Resp(201, {"token": "tok-1", "expires_at": expires}))
    provider = _provider_returning("jwt")
    cache = gha.InstallationTokenCache()

    cache.get(installation_id=1, app_jwt_provider=provider, http_client=client)
    cache.invalidate(1)
    cache.get(installation_id=1, app_jwt_provider=provider, http_client=client)
    assert provider.state["calls"] == 2


def test_cache_per_installation_isolation():
    """Two different installations get two independent tokens."""
    expires = (
        datetime.now(timezone.utc) + timedelta(minutes=30)
    ).isoformat().replace("+00:00", "Z")
    client = _StubHttpClient(_Resp(201, {"token": "tok-A", "expires_at": expires}))
    provider = _provider_returning("jwt")
    cache = gha.InstallationTokenCache()

    cache.get(installation_id=1, app_jwt_provider=provider, http_client=client)
    client.response = _Resp(201, {"token": "tok-B", "expires_at": expires})
    cache.get(installation_id=2, app_jwt_provider=provider, http_client=client)
    assert provider.state["calls"] == 2


# --- post_pr_comment ------------------------------------------------


def test_post_pr_comment_returns_html_url():
    client = _StubHttpClient(_Resp(201, {
        "id": 999,
        "html_url": "https://github.com/o/r/issues/42#issuecomment-999",
    }))
    url = gha.post_pr_comment(
        repo_full_name="o/r", pr_number=42, body="hello",
        install_token="ghs_x", http_client=client,
    )
    assert url.endswith("issuecomment-999")
    posted_url, kw = client.calls[0]
    assert posted_url.endswith("/repos/o/r/issues/42/comments")
    assert kw["headers"]["Authorization"] == "Bearer ghs_x"
    assert kw["json"] == {"body": "hello"}


def test_post_pr_comment_rejects_bad_repo_format():
    client = _StubHttpClient(_Resp(201, {"html_url": "x"}))
    with pytest.raises(gha.GitHubAppError, match="owner/name"):
        gha.post_pr_comment(
            repo_full_name="just-a-name",  # no slash
            pr_number=1, body="x", install_token="t",
            http_client=client,
        )


def test_post_pr_comment_raises_on_non_201():
    client = _StubHttpClient(_Resp(403, {"message": "forbidden"}))
    with pytest.raises(gha.GitHubAppError, match="status=403"):
        gha.post_pr_comment(
            repo_full_name="o/r", pr_number=42, body="x",
            install_token="t", http_client=client,
        )


def test_post_pr_comment_raises_when_response_missing_html_url():
    client = _StubHttpClient(_Resp(201, {"id": 1}))  # no html_url
    with pytest.raises(gha.GitHubAppError, match="html_url"):
        gha.post_pr_comment(
            repo_full_name="o/r", pr_number=42, body="x",
            install_token="t", http_client=client,
        )


# --- post_ack_comment end-to-end -----------------------------------


def test_post_ack_comment_uses_cache_then_posts(rsa_keypair):
    expires = (
        datetime.now(timezone.utc) + timedelta(minutes=30)
    ).isoformat().replace("+00:00", "Z")

    class _MultiResponseClient:
        """Returns a different response per URL so we can drive the
        full token-mint → comment-post sequence with one client."""

        def __init__(self):
            self.calls: list[tuple[str, dict]] = []

        def post(self, url, **kw):
            self.calls.append((url, kw))
            if "access_tokens" in url:
                return _Resp(201, {"token": "ghs_t", "expires_at": expires})
            if "comments" in url:
                return _Resp(201, {"html_url": "https://github.com/o/r/issues/1#c-9"})
            return _Resp(404, {"message": "unknown"})

        def close(self):
            pass

    client = _MultiResponseClient()
    cfg = gha.GitHubAppConfig(
        app_id="42", private_key_pem=rsa_keypair["private_pem"],
    )
    cache = gha.InstallationTokenCache()
    url = gha.post_ack_comment(
        cfg=cfg, installation_id=99,
        repo_full_name="o/r", pr_number=1,
        body="hello", cache=cache, http_client=client,
    )
    assert url.endswith("c-9")
    # Verify both calls were made (token mint then comment post).
    assert len(client.calls) == 2
    assert "access_tokens" in client.calls[0][0]
    assert "comments" in client.calls[1][0]
    # And the cache now has the token, so a second call doesn't mint
    # a new one.
    url2 = gha.post_ack_comment(
        cfg=cfg, installation_id=99,
        repo_full_name="o/r", pr_number=1,
        body="hi again", cache=cache, http_client=client,
    )
    assert url2.endswith("c-9")
    # Only one access_tokens call total — second post_ack_comment
    # reused the cached token.
    access_calls = [c for c in client.calls if "access_tokens" in c[0]]
    assert len(access_calls) == 1
