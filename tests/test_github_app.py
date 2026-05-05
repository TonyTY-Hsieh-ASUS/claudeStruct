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
    """Records POSTs / GETs; returns a per-test scripted response.

    Each test wires up the response it expects via either
    ``response`` (single-call tests) or ``responses`` (a list,
    consumed in order — for the multi-step primitives like
    branch creation that fire 2+ requests).
    """

    def __init__(
        self,
        response: _Resp | None = None,
        *,
        responses: list[_Resp] | None = None,
    ):
        self.response = response
        self.responses = list(responses) if responses else None
        self.calls: list[tuple[str, str, dict]] = []  # (verb, url, kw)

    def _next_response(self) -> _Resp:
        if self.responses is not None:
            return self.responses.pop(0)
        assert self.response is not None, "stub has no responses queued"
        return self.response

    def post(self, url, **kw):
        self.calls.append(("POST", url, kw))
        return self._next_response()

    def get(self, url, **kw):
        self.calls.append(("GET", url, kw))
        return self._next_response()

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
    # client.calls is a list of (verb, url, kw) tuples; index 1 is
    # the URL and index 2 is the kwargs.
    assert client.calls[0][1].endswith("/app/installations/99/access_tokens")
    assert client.calls[0][2]["headers"]["Authorization"] == "Bearer jwt"


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
    verb, posted_url, kw = client.calls[0]
    assert verb == "POST"
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
    # _MultiResponseClient is local to this test and uses the
    # legacy (url, kw) tuple shape.
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


# --- W6.6: branch + PR creation primitives -------------------------
#
# These tests cover the API building blocks for bot-as-actor PR
# opens. The full worker integration (clone repo, apply patch, push,
# call create_pull_request) is a separate larger lift; locking the
# wire format here means that work doesn't have to re-design the
# GitHub-side calls.


def test_get_default_branch_returns_default_branch_field():
    client = _StubHttpClient(_Resp(200, {
        "default_branch": "main",
        "name": "claudeStruct",
        # We deliberately ignore everything else — keep the dep on
        # the API payload as small as possible so a future GitHub
        # field rename or additive field can't break us.
    }))
    branch = gha.get_default_branch(
        repo_full_name="o/r", install_token="ghs_x", http_client=client,
    )
    assert branch == "main"
    verb, url, kw = client.calls[0]
    assert verb == "GET"
    assert url == "https://api.github.com/repos/o/r"
    assert kw["headers"]["Authorization"] == "Bearer ghs_x"


def test_get_default_branch_rejects_bad_repo_format():
    client = _StubHttpClient(_Resp(200, {"default_branch": "main"}))
    with pytest.raises(gha.GitHubAppError, match="owner/name"):
        gha.get_default_branch(
            repo_full_name="not-a-slash", install_token="x", http_client=client,
        )


def test_get_default_branch_raises_on_missing_field():
    client = _StubHttpClient(_Resp(200, {"name": "no-default-branch-key"}))
    with pytest.raises(gha.GitHubAppError, match="missing default_branch"):
        gha.get_default_branch(
            repo_full_name="o/r", install_token="x", http_client=client,
        )


def test_get_default_branch_raises_on_non_200():
    client = _StubHttpClient(_Resp(404, {"message": "Not Found"}))
    with pytest.raises(gha.GitHubAppError, match="status=404"):
        gha.get_default_branch(
            repo_full_name="o/r", install_token="x", http_client=client,
        )


def test_get_ref_sha_normalises_refs_heads_prefix():
    """Callers shouldn't have to remember whether to pass `main`
    or `refs/heads/main` — both forms should hit the same URL."""
    bare = _StubHttpClient(_Resp(200, {"object": {"sha": "a" * 40}}))
    full = _StubHttpClient(_Resp(200, {"object": {"sha": "a" * 40}}))
    sha_a = gha.get_ref_sha(
        repo_full_name="o/r", ref="main",
        install_token="x", http_client=bare,
    )
    sha_b = gha.get_ref_sha(
        repo_full_name="o/r", ref="refs/heads/main",
        install_token="x", http_client=full,
    )
    assert sha_a == sha_b == "a" * 40
    assert bare.calls[0][1] == full.calls[0][1]
    assert bare.calls[0][1].endswith("/git/ref/heads/main")


def test_get_ref_sha_raises_on_short_sha():
    """Defensive: GitHub always returns 40-char SHAs. Anything else
    means the response shape changed and we'd rather raise than
    pass garbage down to create_branch."""
    client = _StubHttpClient(_Resp(200, {"object": {"sha": "abcd"}}))
    with pytest.raises(gha.GitHubAppError, match="40-char sha"):
        gha.get_ref_sha(
            repo_full_name="o/r", ref="main",
            install_token="x", http_client=client,
        )


def test_get_ref_sha_raises_on_non_200():
    client = _StubHttpClient(_Resp(404, {"message": "Branch not found"}))
    with pytest.raises(gha.GitHubAppError, match="status=404"):
        gha.get_ref_sha(
            repo_full_name="o/r", ref="missing",
            install_token="x", http_client=client,
        )


def test_create_branch_posts_full_ref_form():
    """Body must use `refs/heads/<name>` form regardless of how the
    caller passed the branch — GitHub's Refs API rejects bare names."""
    client = _StubHttpClient(_Resp(201, {"object": {"sha": "b" * 40}}))
    sha = gha.create_branch(
        repo_full_name="o/r", branch="cs/run-123",
        base_sha="a" * 40,
        install_token="x", http_client=client,
    )
    assert sha == "b" * 40
    _, url, kw = client.calls[0]
    assert url == "https://api.github.com/repos/o/r/git/refs"
    assert kw["json"] == {"ref": "refs/heads/cs/run-123", "sha": "a" * 40}


def test_create_branch_accepts_pre_normalised_ref():
    """If the caller already wrote `refs/heads/x`, don't double-prefix."""
    client = _StubHttpClient(_Resp(201, {"object": {"sha": "b" * 40}}))
    gha.create_branch(
        repo_full_name="o/r", branch="refs/heads/cs/x",
        base_sha="a" * 40,
        install_token="x", http_client=client,
    )
    _, _, kw = client.calls[0]
    assert kw["json"]["ref"] == "refs/heads/cs/x"  # single prefix


def test_create_branch_raises_on_422_already_exists():
    """The 422 path is the most likely failure (retry colliding
    with a prior attempt's branch). Lock the message shape so
    operators can grep for `status=422`."""
    client = _StubHttpClient(_Resp(422, {"message": "Reference already exists"}))
    with pytest.raises(gha.GitHubAppError, match="status=422"):
        gha.create_branch(
            repo_full_name="o/r", branch="dup",
            base_sha="a" * 40,
            install_token="x", http_client=client,
        )


def test_create_pull_request_defaults_to_draft():
    """Default draft=True so the App's PRs don't immediately page
    reviewers. A follow-up workflow flips them to ready when CI is
    green; the operator can also override draft=False on
    one-off calls."""
    client = _StubHttpClient(_Resp(201, {
        "number": 42,
        "html_url": "https://github.com/o/r/pull/42",
        "head": {"sha": "c" * 40},
    }))
    pr = gha.create_pull_request(
        repo_full_name="o/r",
        head="cs/run-123",
        base="main",
        title="cs review fix",
        body="auto-generated by claudeStruct\n",
        install_token="x",
        http_client=client,
    )
    assert pr["number"] == 42
    assert pr["html_url"].endswith("/pull/42")
    _, url, kw = client.calls[0]
    assert url == "https://api.github.com/repos/o/r/pulls"
    body = kw["json"]
    assert body["draft"] is True
    assert body["head"] == "cs/run-123"
    assert body["base"] == "main"


def test_create_pull_request_explicit_non_draft():
    client = _StubHttpClient(_Resp(201, {
        "number": 1, "html_url": "https://x", "head": {"sha": "c" * 40},
    }))
    gha.create_pull_request(
        repo_full_name="o/r", head="x", base="main",
        title="t", body="b",
        install_token="x", http_client=client,
        draft=False,
    )
    _, _, kw = client.calls[0]
    assert kw["json"]["draft"] is False


def test_create_pull_request_rejects_empty_head_or_base():
    client = _StubHttpClient(_Resp(201, {"number": 1, "html_url": "https://x"}))
    with pytest.raises(gha.GitHubAppError, match="head and base"):
        gha.create_pull_request(
            repo_full_name="o/r", head="", base="main",
            title="t", body="b",
            install_token="x", http_client=client,
        )


def test_create_pull_request_raises_on_non_201():
    client = _StubHttpClient(_Resp(422, {"message": "Validation Failed"}))
    with pytest.raises(gha.GitHubAppError, match="status=422"):
        gha.create_pull_request(
            repo_full_name="o/r", head="x", base="main",
            title="t", body="b",
            install_token="x", http_client=client,
        )


def test_create_pull_request_raises_when_response_missing_keys():
    client = _StubHttpClient(_Resp(201, {"unexpected": True}))
    with pytest.raises(gha.GitHubAppError, match="missing number/html_url"):
        gha.create_pull_request(
            repo_full_name="o/r", head="x", base="main",
            title="t", body="b",
            install_token="x", http_client=client,
        )
