"""Trazas OpenTelemetry (OTLP/HTTP) para servicios Python. Activas solo con OTEL_EXPORTER_OTLP_ENDPOINT.

Spans con atributos pseudónimos (UUIDs de tenant/usuario, modelo, conteos y latencias); nunca texto de
preguntas, respuestas ni documentos. Propagación W3C traceparent desde la API y desde mensajes SQS.
"""

from __future__ import annotations

import os
import time
from collections.abc import Iterator, Mapping
from contextlib import contextmanager

from opentelemetry import context as otel_context
from opentelemetry import propagate, trace

_initialized = False


def init_tracing(service_name: str) -> bool:
    global _initialized
    if _initialized or not os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT"):
        return _initialized
    from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
    from opentelemetry.sdk.resources import Resource
    from opentelemetry.sdk.trace import TracerProvider
    from opentelemetry.sdk.trace.export import BatchSpanProcessor

    provider = TracerProvider(resource=Resource.create({
        "service.name": os.environ.get("OTEL_SERVICE_NAME", service_name),
        "deployment.environment.name": os.environ.get("RAGSIS_ENV", "local"),
    }))
    provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter()))
    trace.set_tracer_provider(provider)
    _initialized = True
    return True


def shutdown_tracing() -> None:
    provider = trace.get_tracer_provider()
    if hasattr(provider, "shutdown"):
        provider.shutdown()


def tracer() -> trace.Tracer:
    return trace.get_tracer("ragsis")


@contextmanager
def remote_parent(carrier: Mapping[str, str] | None) -> Iterator[None]:
    """Activa como padre el contexto W3C recibido (headers HTTP o campo del mensaje)."""
    if not carrier:
        yield
        return
    token = otel_context.attach(propagate.extract(dict(carrier)))
    try:
        yield
    finally:
        otel_context.detach(token)


@contextmanager
def stage(name: str, timings: dict | None = None, **attributes) -> Iterator[trace.Span]:
    """Span + medición de latencia en `timings[name]` (ms)."""
    t0 = time.perf_counter()
    with tracer().start_as_current_span(name, attributes={k: v for k, v in attributes.items() if v is not None}) as span:
        try:
            yield span
        finally:
            if timings is not None:
                timings[name.rsplit(".", 1)[-1]] = int((time.perf_counter() - t0) * 1000)
