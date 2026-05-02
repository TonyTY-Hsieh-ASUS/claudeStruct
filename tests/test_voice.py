"""Tests for `claudestruct.voice` (W10.7 — voice REPL).

We never touch real audio hardware or load a real Whisper model in
these tests — both are slow + flaky in CI. Instead we exercise the
orchestrator with injected fakes, and gate on the lazy-import error
when the [voice] extra isn't installed.
"""
from __future__ import annotations

from typing import Any

import pytest

from claudestruct import voice

# --- VoiceConfig ---------------------------------------------------


def test_voice_config_defaults_target_gx10():
    """The defaults are the contract: changing them affects every
    user, so lock them with an explicit test."""
    cfg = voice.VoiceConfig()
    assert cfg.model == "base.en"
    assert cfg.language is None  # auto-detect
    assert cfg.sample_rate == 16_000  # Whisper-native; no resample
    assert cfg.seconds == 5.0
    assert cfg.device is None  # let faster-whisper auto-pick
    assert cfg.extras == {}


def test_voice_config_overrides_apply():
    cfg = voice.VoiceConfig(model="small", language="zh", seconds=10.0, device="cpu")
    assert cfg.model == "small"
    assert cfg.language == "zh"
    assert cfg.seconds == 10.0
    assert cfg.device == "cpu"


# --- capture_and_transcribe orchestration --------------------------


def test_capture_and_transcribe_uses_injected_recorder_and_transcriber():
    """The injection points are the test surface — production code
    passes None and gets the real audio + Whisper paths."""
    captured_calls = {"rec": 0, "tx": 0}

    def fake_record(cfg: voice.VoiceConfig) -> Any:
        captured_calls["rec"] += 1
        assert cfg.seconds == 7.0  # passthrough
        return "FAKE_AUDIO"

    def fake_transcribe(audio: Any, cfg: voice.VoiceConfig) -> str:
        captured_calls["tx"] += 1
        assert audio == "FAKE_AUDIO"  # arrives untouched
        assert cfg.language == "zh"
        return "你好世界"

    text = voice.capture_and_transcribe(
        voice.VoiceConfig(seconds=7.0, language="zh"),
        recorder=fake_record,
        transcriber=fake_transcribe,
    )
    assert text == "你好世界"
    assert captured_calls == {"rec": 1, "tx": 1}


def test_capture_and_transcribe_default_config_when_none():
    """Passing config=None should construct a default. Locking this
    so the convenience path doesn't silently regress."""
    seen: dict[str, voice.VoiceConfig] = {}

    def rec(cfg):
        seen["cfg"] = cfg
        return None

    voice.capture_and_transcribe(
        recorder=rec,
        transcriber=lambda audio, cfg: "",
    )
    assert seen["cfg"].model == "base.en"
    assert seen["cfg"].seconds == 5.0


def test_capture_and_transcribe_propagates_voice_error():
    """A VoiceError from the recorder must bubble — the CLI catches
    it and renders a clean message. Don't swallow."""

    def boom(cfg: voice.VoiceConfig) -> Any:
        raise voice.VoiceError("mic exploded")

    with pytest.raises(voice.VoiceError, match="mic exploded"):
        voice.capture_and_transcribe(
            recorder=boom,
            transcriber=lambda audio, cfg: "unreachable",
        )


def test_capture_and_transcribe_returns_empty_when_no_speech():
    """Empty STT result must propagate — the CLI distinguishes
    "no speech detected" from "a real transcription". Don't crash."""
    text = voice.capture_and_transcribe(
        recorder=lambda cfg: "AUDIO",
        transcriber=lambda audio, cfg: "",
    )
    assert text == ""


# --- Lazy-import gating --------------------------------------------


def test_import_audio_deps_raises_voice_error_when_missing(monkeypatch):
    """When the [voice] extra isn't installed, _import_audio_deps
    must raise VoiceError pointing at the install command — not the
    raw ImportError stack trace."""
    import builtins

    real_import = builtins.__import__

    def fake_import(name, *args, **kwargs):
        if name in ("sounddevice", "numpy"):
            raise ImportError(f"No module named {name!r}")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", fake_import)
    with pytest.raises(voice.VoiceError, match=r"\[voice\] extra"):
        voice._import_audio_deps()


def test_import_whisper_raises_voice_error_when_missing(monkeypatch):
    """Symmetric guarantee for the STT side."""
    import builtins

    real_import = builtins.__import__

    def fake_import(name, *args, **kwargs):
        if name == "faster_whisper":
            raise ImportError("No module named 'faster_whisper'")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", fake_import)
    with pytest.raises(voice.VoiceError, match=r"\[voice\] extra"):
        voice._import_whisper()


# --- Model cache ----------------------------------------------------


def test_load_model_caches_per_config(monkeypatch):
    """Repeated `cs voice` invocations within one process should reuse
    the loaded weights — re-loading 140 MB every call would dominate
    the wall time."""
    voice.reset_model_cache()
    load_count = {"n": 0}

    class FakeModel:
        def __init__(self, name: str, device: str):
            load_count["n"] += 1
            self.name = name
            self.device = device

    monkeypatch.setattr(voice, "_import_whisper", lambda: FakeModel)

    cfg = voice.VoiceConfig(model="base.en", device="cpu")
    m1 = voice._load_model(cfg)
    m2 = voice._load_model(cfg)
    assert m1 is m2
    assert load_count["n"] == 1

    # Different config (different model) should trigger another load.
    cfg2 = voice.VoiceConfig(model="small", device="cpu")
    voice._load_model(cfg2)
    assert load_count["n"] == 2


def test_reset_model_cache_clears_cached_instances(monkeypatch):
    voice.reset_model_cache()

    class FakeModel:
        def __init__(self, name: str, device: str):
            pass

    monkeypatch.setattr(voice, "_import_whisper", lambda: FakeModel)
    cfg = voice.VoiceConfig()
    voice._load_model(cfg)
    assert len(voice._MODEL_CACHE) == 1
    voice.reset_model_cache()
    assert len(voice._MODEL_CACHE) == 0


# --- transcribe_audio with fake model ------------------------------


def test_transcribe_audio_concatenates_segments_and_strips(monkeypatch):
    """faster-whisper returns a generator of segments + a separate
    info object. We concat segment.text and trim — that's the
    contract callers depend on."""
    voice.reset_model_cache()

    class FakeSegment:
        def __init__(self, text: str):
            self.text = text

    class FakeModel:
        def __init__(self, *_a, **_kw):
            pass

        def transcribe(self, audio, language=None, **extras):
            assert language == "zh"  # config passthrough
            assert extras == {"vad_filter": True}
            return iter([FakeSegment(" hello "), FakeSegment("world ")]), object()

    monkeypatch.setattr(voice, "_import_whisper", lambda: FakeModel)

    cfg = voice.VoiceConfig(language="zh", extras={"vad_filter": True})
    out = voice.transcribe_audio(audio=object(), config=cfg)
    assert out == "hello world"
