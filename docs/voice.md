# `cs voice`: hands-busy claudestruct (W10.7)

`cs voice transcribe` records a few seconds from the default
microphone, runs Whisper locally, and prints the transcription.
`cs voice run <task>` does the same and immediately invokes
`cs dev/review/plan/debug` with the captured text — useful when typing
isn't an option (driving, kitchen, accessibility).

Designed to land natively on a GX10's compute budget: the default
`base.en` Whisper model is ~140 MB and produces sub-200 ms latency for
five seconds of English audio. None of the audio stack is imported
until you actually run a `cs voice` command, so the base install stays
small.

## Setup

```bash
pip install 'claudestruct[voice]'
# Brings: faster-whisper, sounddevice, numpy.
```

On Linux you may also need `portaudio19-dev` (Debian/Ubuntu) or
`portaudio` (Fedora) for the sounddevice bindings — the package
installs but the import will explain if it's missing.

## Quick uses

```bash
# Transcribe-only, pipe into anything:
cs voice transcribe
# > "review the latest commit on the billing module"

cs dev "$(cs voice transcribe --seconds 10)"

# Or skip the pipe and let cs do the dispatch:
cs voice run review
# > [dim]listening for 5.0s…[/dim]
# > [bold]heard:[/bold] check the input validation in the new endpoint
# > … cs review starts immediately with that description …
```

## Flags

| Flag         | Default     | Meaning                                                 |
|--------------|-------------|---------------------------------------------------------|
| `--seconds`  | `5.0`       | Recording length. Bump for longer queries.              |
| `--language` | auto-detect | ISO 639-1 / Whisper language code (`zh`, `ja`, `de`).   |
| `--model`    | `base.en`   | Whisper model. Use `small` / `medium` for accents.      |
| `--device`   | auto        | Whisper compute device (`cpu`, `cuda`, `auto`).         |
| `--print-only` (run only) | off | Print the transcription instead of dispatching. |

## Traditional Chinese

```bash
cs voice transcribe --language zh
# Whisper doesn't distinguish zh-tw from zh-cn at the model level —
# the transcription itself reflects the speaker's variant.
```

## Latency budget

| Stage         | GX10 (CUDA)  | Laptop (CPU)         |
|---------------|--------------|----------------------|
| Mic capture   | wall-clock = `--seconds` | wall-clock = `--seconds` |
| Whisper STT   | ~150 ms      | ~600 ms              |
| Cs dispatch   | depends on the task; `--smart-context` adds a single embedding round-trip |

The first invocation in a process loads the Whisper weights (~140 MB
for `base.en`); subsequent calls hit the in-process model cache and
skip that cost.

## Failure modes

| Symptom | Cause | Fix |
|---------|-------|-----|
| `voice features require the [voice] extra` | Base install only | `pip install 'claudestruct[voice]'` |
| `failed to capture audio from default mic` | OS denied mic permission | Grant permission in System Settings → re-run |
| `captured 0 samples` | Sample-rate / device mismatch | Override `--device`, or check `python -c "import sounddevice; print(sounddevice.query_devices())"` |
| `no speech detected` | Mic muted / quiet | Speak louder, or verify `arecord -l` (Linux) sees the device |

## Why no `cs <task> --voice`?

We considered making voice an option flag on every task command. Two
reasons against:

1. The CLI's option matrix is already wide; adding `--voice` to every
   task duplicates the recording flags four times.
2. Voice capture is a separable concern — sometimes you want the
   transcription without dispatch (Slack, copy-paste, downstream
   piping). `cs voice transcribe` covers that without a special flag.

`cs voice run <task>` is the one place that handles dispatch, so the
shape stays consistent if we add `cs voice run claw-squad …` later.
