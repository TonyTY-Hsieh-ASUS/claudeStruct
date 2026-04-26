"""Tracing module tests.

The OTel SDK is a soft dep — most tests run with it installed, but
the no-op fallback path is also covered. We test:
  - Disabled-by-default: without OTEL_EXPORTER_OTLP_ENDPOINT, span()
    yields a no-op object; init returns False.
  - Idempotent init: a second init() returns the same enabled flag.
  - The no-op span object accepts all the methods callers use without
    raising — preserves the "wrap unconditionally" usage pattern.
"""
from __future__ import annotations

import importlib

import pytest

from claudestruct import tracing


@pytest.fixture(autouse=True)
def _reset(monkeypatch):
    """Tracing has module-level state; reset between cases so one test
    enabling it doesn't leak into the next."""
    monkeypatch.setattr(tracing, "_initialized", False)
    monkeypatch.setattr(tracing, "_enabled", False)
    monkeypatch.setattr(tracing, "_tracer", None)
    yield


def test_disabled_when_endpoint_unset(monkeypatch):
    monkeypatch.delenv("OTEL_EXPORTER_OTLP_ENDPOINT", raising=False)
    assert tracing.init_tracing() is False
    assert tracing.is_enabled() is False


def test_span_is_noop_when_disabled(monkeypatch):
    monkeypatch.delenv("OTEL_EXPORTER_OTLP_ENDPOINT", raising=False)
    tracing.init_tracing()
    with tracing.span("noop.test", attributes={"k": "v"}) as s:
        # No-op span accepts every method the caller might invoke.
        s.set_attribute("foo", "bar")
        s.set_attribute("count", 42)
        s.record_exception(RuntimeError("x"))


def test_init_is_idempotent(monkeypatch):
    monkeypatch.delenv("OTEL_EXPORTER_OTLP_ENDPOINT", raising=False)
    assert tracing.init_tracing() is False
    # Second call returns the same answer without re-initialising.
    assert tracing.init_tracing() is False


def _swap_exporter_with_noop(monkeypatch):
    """Replace the OTLP HTTP exporter with a no-op so init() succeeds
    without spawning a background HTTP retry loop. We're testing the
    init + span surface, not the exporter network path."""
    pytest.importorskip("opentelemetry")
    from opentelemetry.exporter.otlp.proto.http import trace_exporter

    class _NoopExporter:
        def __init__(self, *a, **kw):
            pass
        def export(self, _spans):  # pragma: no cover — never invoked here
            return 0  # SUCCESS
        def shutdown(self):
            pass
        def force_flush(self, _timeout_millis=None):
            return True

    monkeypatch.setattr(trace_exporter, "OTLPSpanExporter", _NoopExporter)


def test_enabled_when_endpoint_set(monkeypatch):
    monkeypatch.setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://localhost:4318")
    _swap_exporter_with_noop(monkeypatch)
    assert tracing.init_tracing() is True
    assert tracing.is_enabled() is True
    tracing.shutdown()


def test_span_records_attributes_when_enabled(monkeypatch):
    monkeypatch.setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://localhost:4318")
    _swap_exporter_with_noop(monkeypatch)
    tracing.init_tracing()
    # Real span — verifies mixed-type attributes don't raise. The
    # exporter is a no-op so nothing leaves the process.
    with tracing.span("test.op", attributes={
        "string_attr": "value",
        "int_attr": 42,
        "float_attr": 3.14,
        "bool_attr": True,
        "none_attr": None,
        "list_attr": ["a", "b"],  # gets stringified
    }) as s:
        s.set_attribute("late.attr", "added")
    tracing.shutdown()


def test_shutdown_is_safe_when_disabled(monkeypatch):
    monkeypatch.delenv("OTEL_EXPORTER_OTLP_ENDPOINT", raising=False)
    tracing.init_tracing()
    # Should not raise, should not access the SDK.
    tracing.shutdown()
