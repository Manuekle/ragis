# syntax=docker/dockerfile:1.7
# Producción: fijar imágenes por digest y generar SBOM en CI.
FROM python:3.12-slim AS build
COPY --from=ghcr.io/astral-sh/uv:0.9.9 /uv /bin/uv
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy UV_PYTHON_DOWNLOADS=never
WORKDIR /app
COPY pyproject.toml uv.lock .python-version ./
COPY packages/ragsis-core packages/ragsis-core
COPY services/ai-gateway services/ai-gateway
COPY services/rag-engine services/rag-engine
COPY services/ingest-worker services/ingest-worker
COPY eval/pyproject.toml eval/pyproject.toml
COPY eval/src eval/src
RUN uv sync --frozen --no-dev --no-editable --package ragsis-rag

FROM python:3.12-slim
ENV PATH=/app/.venv/bin:$PATH PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1
WORKDIR /app
COPY --from=build /app/.venv /app/.venv
RUN useradd --uid 10001 --no-create-home ragsis
USER 10001
EXPOSE 8080
CMD ["uvicorn", "ragsis_rag.app:app", "--host", "0.0.0.0", "--port", "8080", "--no-access-log"]
