"""Voice capture + transcription (W10.7).

`cs voice transcribe` records from the default mic, runs Whisper
locally, and prints the transcription. `cs voice run <task>` does the
same and pipes the result into `cs dev/review/plan/debug` so a
hands-busy / driving / kitchen workflow can stay productive.

The implementation is intentionally split into small, testable
pieces:

  * `record_audio(...)` — mic capture (sounddevice + numpy).
  * `transcribe_audio(...)` — STT (faster-whisper).
  * `capture_and_transcribe(...)` — orchestrator that calls both.

Each lazy-imports its heavy dep so the base `pip install
claudestruct` stays small. ImportError surfaces a clear ``VoiceError``
pointing at the ``[voice]`` extra rather than the SDK's own message.

Defaults aim at GX10's strengths:
  * ``base.en`` model — ~140 MB, < 200 ms STT for 5 s English audio.
  * 16 kHz mono — Whisper's native sample rate; no resample step.
  * 5 s default capture — typical voice query length; tunable.
"""
from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any


class VoiceError(RuntimeError):
    """Raised on missing [voice] extra, mic failure, or empty audio.
    Caller (CLI) renders + exits; tests assert on the message."""


@dataclass
class VoiceConfig:
    """Runtime knobs for capture + transcription. Chosen so the
    no-arg path on a GX10 just works; every field is overridable for
    smaller / non-English / multi-speaker setups."""

    model: str = "base.en"
    """Whisper model name. ``base.en`` is the speed/quality sweet spot
    on a GX10 for English; use ``small`` / ``medium`` for accents /
    noise. The tiny-language variants (``tiny.en``) shave latency on
    weaker hardware."""

    language: str | None = None
    """ISO 639-1 / Whisper language code. ``None`` lets Whisper detect.
    Pass ``"zh"`` for Traditional Chinese (faster-whisper doesn't
    distinguish ``zh-tw`` from ``zh-cn`` at the model level — the
    transcription itself reflects the speaker's variant)."""

    sample_rate: int = 16_000
    """Whisper's native rate. Resampling is silent quality loss; we
    capture at 16k directly."""

    seconds: float = 5.0
    """Default capture length. Long enough for a typical query,
    short enough that a misplaced run isn't an expensive surprise."""

    device: str | None = None
    """Whisper compute device. ``None`` lets faster-whisper auto-pick
    (CUDA on a GX10, CPU on a laptop). Override to ``"cpu"`` to skip
    the GPU even when one's present (useful for benchmarking)."""

    extras: dict[str, Any] = field(default_factory=dict)
    """Forwarded to ``WhisperModel.transcribe()`` — escape hatch for
    parameters we don't promote (initial_prompt, vad_filter, etc.)."""


# --- Recording ------------------------------------------------------


def _import_audio_deps() -> tuple[Any, Any]:
    """Lazy-import sounddevice + numpy. The error message points at
    the extra rather than at PyPI's stack trace, so users don't have
    to read the import chain to find the fix."""
    try:
        import numpy as np  # noqa: F401  (re-exported for callers)
        import sounddevice as sd
    except ImportError as exc:  # pragma: no cover -- exercised via VoiceError test
        raise VoiceError(
            "voice features require the [voice] extra:\n"
            "  pip install 'claudestruct[voice]'\n"
            f"  (underlying ImportError: {exc})"
        ) from exc
    return sd, np


def record_audio(config: VoiceConfig) -> Any:
    """Record ``config.seconds`` of mono audio at ``config.sample_rate``.

    Returns a numpy float32 array shape (N,) — Whisper's expected
    input. Blocks until the recording finishes; ``sd.wait()`` is the
    sounddevice idiom for "let the buffer fill before I touch it".

    Raises ``VoiceError`` when the mic isn't accessible (no device,
    permissions denied, busy by another process). The underlying
    PortAudioError gets wrapped so the CLI message stays in our
    voice.
    """
    sd, np = _import_audio_deps()
    n_samples = int(config.seconds * config.sample_rate)
    try:
        recording = sd.rec(
            n_samples,
            samplerate=config.sample_rate,
            channels=1,
            dtype="float32",
        )
        sd.wait()
    except Exception as exc:  # PortAudioError isn't importable cross-platform
        raise VoiceError(
            f"failed to capture audio from default mic: {exc}\n"
            "  Check OS-level mic permissions, then re-run."
        ) from exc
    # sounddevice returns shape (N, 1); flatten so Whisper sees mono.
    audio = np.asarray(recording, dtype=np.float32).reshape(-1)
    if audio.size == 0:
        raise VoiceError("captured 0 samples — sample rate / device misconfigured?")
    return audio


# --- Transcription -------------------------------------------------


def _import_whisper() -> Any:
    """Lazy-import faster-whisper. Mirrors ``_import_audio_deps``."""
    try:
        from faster_whisper import WhisperModel
    except ImportError as exc:  # pragma: no cover
        raise VoiceError(
            "voice features require the [voice] extra:\n"
            "  pip install 'claudestruct[voice]'\n"
            f"  (underlying ImportError: {exc})"
        ) from exc
    return WhisperModel


# Module-level model cache. Keeps repeated `cs voice` invocations from
# re-loading 140 MB of weights every time. Populated on first use;
# tests reset it via the loader injection point.
_MODEL_CACHE: dict[tuple[str, str | None], Any] = {}


def _load_model(config: VoiceConfig) -> Any:
    """Load (or fetch from cache) the Whisper model. Hoisted so tests
    can inject a fake by replacing this symbol."""
    WhisperModel = _import_whisper()
    key = (config.model, config.device)
    if key not in _MODEL_CACHE:
        _MODEL_CACHE[key] = WhisperModel(
            config.model, device=config.device or "auto"
        )
    return _MODEL_CACHE[key]


def transcribe_audio(audio: Any, config: VoiceConfig) -> str:
    """Whisper STT on a numpy float32 mono array.

    Returns the concatenated text of every recognised segment. Empty
    return is fine — the caller decides whether to abort or just
    print "no speech detected".
    """
    model = _load_model(config)
    segments, _info = model.transcribe(
        audio,
        language=config.language,
        **config.extras,
    )
    # ``segments`` is a generator in faster-whisper; force iteration
    # so transcription actually runs (not just the call to
    # ``transcribe()``, which is lazy).
    return "".join(s.text for s in segments).strip()


# --- Orchestrator --------------------------------------------------


def capture_and_transcribe(
    config: VoiceConfig | None = None,
    *,
    recorder: Callable[[VoiceConfig], Any] | None = None,
    transcriber: Callable[[Any, VoiceConfig], str] | None = None,
) -> str:
    """Record + transcribe in one call. ``recorder`` / ``transcriber``
    injection points are how tests skip the real audio + Whisper
    paths; production code passes ``None`` and gets the real ones.

    Returns the (possibly empty) transcription. Raises ``VoiceError``
    if recording fails — STT failures are propagated unchanged so the
    operator can see the underlying cause.
    """
    cfg = config or VoiceConfig()
    rec = recorder or record_audio
    tx = transcriber or transcribe_audio
    audio = rec(cfg)
    return tx(audio, cfg)


def reset_model_cache() -> None:
    """Drop cached Whisper model instances. Used by tests to ensure
    each case loads with the configured fake; callers usually don't
    need this."""
    _MODEL_CACHE.clear()
