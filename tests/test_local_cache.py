"""Tests for the content-hashed local LLM response cache (W9.4)."""
from __future__ import annotations

from pathlib import Path

import pytest

from claudestruct import local_cache

# --- cache_key ------------------------------------------------------


def test_cache_key_stable_for_identical_inputs():
    a = local_cache.cache_key(
        provider="ollama", model="qwen2.5-coder:32b",
        system="you are a helpful coder",
        messages=[{"role": "user", "content": "hi"}],
    )
    b = local_cache.cache_key(
        provider="ollama", model="qwen2.5-coder:32b",
        system="you are a helpful coder",
        messages=[{"role": "user", "content": "hi"}],
    )
    assert a == b
    assert len(a) == 64  # SHA-256 hex


def test_cache_key_differs_when_provider_differs():
    base = dict(
        model="qwen2.5-coder:32b", system="x",
        messages=[{"role": "user", "content": "hi"}],
    )
    assert (
        local_cache.cache_key(provider="ollama", **base)
        != local_cache.cache_key(provider="vllm", **base)
    )


def test_cache_key_differs_when_model_differs():
    base = dict(
        provider="ollama", system="x",
        messages=[{"role": "user", "content": "hi"}],
    )
    assert (
        local_cache.cache_key(model="qwen2.5-coder:32b", **base)
        != local_cache.cache_key(model="llama-3.3:70b", **base)
    )


def test_cache_key_differs_when_system_differs():
    base = dict(
        provider="ollama", model="x",
        messages=[{"role": "user", "content": "hi"}],
    )
    assert (
        local_cache.cache_key(system="be terse", **base)
        != local_cache.cache_key(system="be verbose", **base)
    )


def test_cache_key_differs_when_messages_differ():
    base = dict(provider="ollama", model="x", system="s")
    assert (
        local_cache.cache_key(messages=[{"role": "user", "content": "hi"}], **base)
        != local_cache.cache_key(
            messages=[{"role": "user", "content": "hello"}], **base,
        )
    )


def test_cache_key_stable_against_dict_key_order():
    """JSON dict iteration order shouldn't affect the key — sort_keys
    handles this."""
    a = local_cache.cache_key(
        provider="ollama", model="x", system="s",
        messages=[{"role": "user", "content": "hi"}],
    )
    b = local_cache.cache_key(
        provider="ollama", model="x", system="s",
        messages=[{"content": "hi", "role": "user"}],  # reversed key order
    )
    assert a == b


# --- get / put ------------------------------------------------------


@pytest.fixture()
def tmp_root(tmp_path: Path) -> Path:
    """Per-test cache root under a tmp dir. Avoids polluting the
    user's real ~/.claudestruct/llm_cache/ during pytest."""
    return tmp_path / "cache"


def _make_response(text: str = "hello world") -> local_cache.CachedResponse:
    return local_cache.CachedResponse(
        text=text,
        input_tokens=42,
        output_tokens=7,
        cache_read_tokens=0,
        cache_creation_tokens=0,
        created_at=1700000000.0,
    )


def test_put_then_get_round_trip(tmp_root: Path):
    key = "a" * 64
    local_cache.put(key, _make_response("the answer"), root=tmp_root)
    loaded = local_cache.get(key, root=tmp_root)
    assert loaded is not None
    assert loaded.text == "the answer"
    assert loaded.input_tokens == 42
    assert loaded.output_tokens == 7


def test_get_returns_none_on_miss(tmp_root: Path):
    assert local_cache.get("missing-key" + "0" * 50, root=tmp_root) is None


def test_get_returns_none_on_corrupt_file(tmp_root: Path):
    """A bad JSON file in the cache must NOT crash callers — treat
    as miss so a single corruption doesn't poison every read."""
    key = "b" * 64
    p = local_cache._path_for(key, root=tmp_root)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text("not json{{{", encoding="utf-8")
    assert local_cache.get(key, root=tmp_root) is None


def test_get_returns_none_on_missing_required_field(tmp_root: Path):
    """A JSON file lacking ``text`` is treated as miss."""
    import json as _json
    key = "c" * 64
    p = local_cache._path_for(key, root=tmp_root)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(_json.dumps({"input_tokens": 1}), encoding="utf-8")
    assert local_cache.get(key, root=tmp_root) is None


def test_put_writes_atomically(tmp_root: Path):
    """Sanity: after put returns, the canonical file exists and the
    .tmp sibling does not."""
    key = "d" * 64
    local_cache.put(key, _make_response(), root=tmp_root)
    p = local_cache._path_for(key, root=tmp_root)
    assert p.exists()
    assert not p.with_suffix(p.suffix + ".tmp").exists()


def test_path_uses_two_level_shard(tmp_root: Path):
    """Defensive: if we ever have 1M entries, directory listing
    of any one shard is small (~4k entries on average)."""
    key = "e" * 64
    p = local_cache._path_for(key, root=tmp_root)
    assert p.parent.name == "ee"
    assert p.name == f"{key}.json"


# --- is_enabled -----------------------------------------------------


def test_is_enabled_default_off(monkeypatch):
    monkeypatch.delenv("CLAUDESTRUCT_LLM_CACHE", raising=False)
    assert local_cache.is_enabled() is False


@pytest.mark.parametrize("val", ["1", "true", "TRUE", "yes", "on"])
def test_is_enabled_truthy_values(monkeypatch, val: str):
    monkeypatch.setenv("CLAUDESTRUCT_LLM_CACHE", val)
    assert local_cache.is_enabled() is True


@pytest.mark.parametrize("val", ["0", "false", "no", "off", ""])
def test_is_enabled_falsy_values(monkeypatch, val: str):
    monkeypatch.setenv("CLAUDESTRUCT_LLM_CACHE", val)
    assert local_cache.is_enabled() is False


# --- stats / clear --------------------------------------------------


def test_stats_empty_dir(tmp_root: Path):
    s = local_cache.stats(root=tmp_root)
    assert s.entries == 0
    assert s.bytes == 0


def test_stats_counts_entries_and_bytes(tmp_root: Path):
    for i in range(3):
        local_cache.put(
            chr(ord("a") + i) * 64,
            _make_response(text=f"r{i}"),
            root=tmp_root,
        )
    s = local_cache.stats(root=tmp_root)
    assert s.entries == 3
    assert s.bytes > 0


def test_stats_ignores_non_json(tmp_root: Path):
    """Stray non-.json files in the shard dirs don't get counted."""
    key = "f" * 64
    local_cache.put(key, _make_response(), root=tmp_root)
    shard = local_cache._path_for(key, root=tmp_root).parent
    (shard / "README.md").write_text("hi", encoding="utf-8")
    s = local_cache.stats(root=tmp_root)
    assert s.entries == 1


def test_clear_removes_every_entry(tmp_root: Path):
    for i in range(3):
        local_cache.put(
            chr(ord("a") + i) * 64,
            _make_response(),
            root=tmp_root,
        )
    deleted = local_cache.clear(root=tmp_root)
    assert deleted == 3
    assert local_cache.stats(root=tmp_root).entries == 0


def test_clear_idempotent_on_empty(tmp_root: Path):
    assert local_cache.clear(root=tmp_root) == 0
    assert local_cache.clear(root=tmp_root) == 0  # still 0, no error


# --- _default_cache_root --------------------------------------------


def test_default_cache_root_respects_env(monkeypatch, tmp_path: Path):
    custom = tmp_path / "custom"
    monkeypatch.setenv("CLAUDESTRUCT_LLM_CACHE_DIR", str(custom))
    assert local_cache._default_cache_root() == custom


def test_default_cache_root_falls_back_to_home(monkeypatch):
    monkeypatch.delenv("CLAUDESTRUCT_LLM_CACHE_DIR", raising=False)
    root = local_cache._default_cache_root()
    assert root.name == "llm_cache"
    assert root.parent.name == ".claudestruct"
