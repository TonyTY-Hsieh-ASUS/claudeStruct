"""OpenTelemetry tracing — opt-in, zero-cost when disabled.

Activates only when `OTEL_EXPORTER_OTLP_ENDPOINT` is set in the
environment (matching the OTel convention). Without it, every helper
in this module is a no-op so unrelated runs pay no overhead and the
heavy `opentelemetry` SDK never loads.

Wired into:
  - `runner.run_task_and_log` — root span "claudestruct.task" with
    `task`, `model`, `prompt_version` attributes; child span for the
    actual `run_task` call carrying input/output token counts.

The OTel SDK is a soft dep: declared as `claudestruct[otel]` extra in
pyproject.toml. When the user enables tracing without installing the
extra, we emit a single warning to stderr and fall back to no-op
spans so the run continues unaffected.

Why OTLP/HTTP and not OTLP/gRPC: HTTP works through restrictive proxies
that block grpc, has no protobuf-compiler runtime cost, and the perf
gap is negligible for the low-volume traces this CLI emits.
"""
from __future__ import annotations

import contextlib
import os
import sys
from collections.abc import Iterator
from typing import Any


class _NoopSpan:
    """Stub span returned when OTel is disabled. Exists so callers can
    always do `with tracing.span(...) as s: s.set_attribute(...)`
    without a None check."""

    def set_attribute(self, _key: str, _value: Any) -> None:
        pass

    def record_exception(self, _exc: BaseException) -> None:
        pass


_NOOP_SPAN = _NoopSpan()


# Module-level flag set on first init_tracing(). Re-init is idempotent.
_initialized: bool = False
_enabled: bool = False
_tracer: Any = None


def is_enabled() -> bool:
    return _enabled


def init_tracing(service_name: str = "claudestruct") -> bool:
    """Initialise tracing if `OTEL_EXPORTER_OTLP_ENDPOINT` is set.

    Returns True if tracing is now active, False otherwise. Idempotent:
    a second call returns the prior result without re-initializing.
    """
    global _initialized, _enabled, _tracer
    if _initialized:
        return _enabled
    _initialized = True

    endpoint = os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT", "").strip()
    if not endpoint:
        _enabled = False
        return False

    try:
        from opentelemetry import trace
        from opentelemetry.exporter.otlp.proto.http.trace_exporter import (
            OTLPSpanExporter,
        )
        from opentelemetry.sdk.resources import Resource
        from opentelemetry.sdk.trace import TracerProvider
        from opentelemetry.sdk.trace.export import BatchSpanProcessor
    except ImportError:
        # Soft dep: don't crash the run, just warn once. Users who
        # want tracing should `pip install claudestruct[otel]`.
        sys.stderr.write(
            "[tracing] OTEL_EXPORTER_OTLP_ENDPOINT is set but the "
            "opentelemetry SDK is not installed. Run "
            "`pip install opentelemetry-api opentelemetry-sdk "
            "opentelemetry-exporter-otlp-proto-http` "
            "(or `pip install claudestruct[otel]`) to enable tracing.\n"
        )
        _enabled = False
        return False

    resource = Resource.create({"service.name": service_name})
    provider = TracerProvider(resource=resource)
    # The OTLP HTTP exporter reads OTEL_EXPORTER_OTLP_ENDPOINT itself,
    # plus standard OTEL_EXPORTER_OTLP_HEADERS for auth tokens.
    exporter = OTLPSpanExporter()
    provider.add_span_processor(BatchSpanProcessor(exporter))
    trace.set_tracer_provider(provider)
    _tracer = trace.get_tracer(service_name)
    _enabled = True
    return True


@contextlib.contextmanager
def span(name: str, attributes: dict[str, Any] | None = None) -> Iterator[Any]:
    """Open a span. Returns a no-op object when tracing is disabled,
    so callers can use the same `with` block unconditionally."""
    if not _enabled or _tracer is None:
        yield _NOOP_SPAN
        return
    with _tracer.start_as_current_span(name) as s:
        if attributes:
            for k, v in attributes.items():
                # OTel only accepts primitives + lists of primitives.
                # Anything else gets stringified — never raise on
                # unexpected types, that's worse than a string label.
                if isinstance(v, (str, int, float, bool)):
                    s.set_attribute(k, v)
                elif v is None:
                    pass
                else:
                    s.set_attribute(k, str(v))
        try:
            yield s
        except BaseException as exc:
            s.record_exception(exc)
            raise


def shutdown() -> None:
    """Flush pending spans. Call before process exit so the BatchSpanProcessor
    doesn't drop in-flight traces. No-op when tracing is disabled."""
    if not _enabled:
        return
    try:
        from opentelemetry import trace
        provider = trace.get_tracer_provider()
        flush = getattr(provider, "shutdown", None)
        if callable(flush):
            flush()
    except Exception:
        # Shutdown is best-effort: a flush failure must not mask the
        # actual run's exit code or stop the process from exiting.
        pass
