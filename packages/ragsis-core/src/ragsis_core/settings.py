from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Configuración común de los servicios Python. Secretos solo por entorno/Secrets Manager."""

    model_config = SettingsConfigDict(env_file=None, extra="ignore")

    ragsis_env: str = "local"
    # Vacío => libpq usa PGHOST/PGUSER/PGPASSWORD/PGDATABASE/PGSSLMODE (secretos inyectados por ECS).
    database_url: str = ""
    db_pool_min: int = 1
    db_pool_max: int = 10

    aws_region: str = "us-east-1"
    s3_endpoint: str | None = None
    s3_bucket: str = "ragsis-documents"
    sqs_endpoint: str | None = None
    sqs_ingest_queue_url: str = ""
    sqs_ingest_dlq_url: str = ""

    internal_service_secret: str = ""
    internal_token_audience: str = "ragsis-rag"  # noqa: S105 - audiencia JWT, no secreto
    internal_token_issuer: str = "ragsis-api"  # noqa: S105 - emisor JWT, no secreto

    ai_default_provider: str = "local"
    ai_embedding_model: str = "local-hash-1024@v1"
    ai_generation_model: str = "local-extractive@v1"
    ai_rerank_model: str = "local-lexical-rerank@v1"
    ollama_base_url: str = "http://localhost:11434"

    malware_scanner: str = "none"
    clamav_host: str = "clamav"
    clamav_port: int = 3310

    # OCR para PDFs escaneados: none | textract
    ocr_provider: str = "none"
    ocr_timeout_seconds: int = 600
    ocr_min_line_confidence: float = 60.0

    # Audio (ADR-030). Transcripción de grabaciones: none | transcribe (Amazon Transcribe).
    transcription_provider: str = "none"
    transcription_timeout_seconds: int = 3600
    transcription_language: str = ""                       # p. ej. es-US; vacío => detección automática
    transcription_language_options: str = "es-US,es-ES,en-US,pt-BR"   # candidatos de la detección automática
    transcription_max_speakers: int = 10                   # < 2 => sin separación de hablantes
    transcription_min_word_confidence: float = 0.4
    audio_max_seconds: int = 14400                         # 4 h por grabación

    # RAG-04 multimodal. Parser: native (sin dependencias nativas) | docling (layout, tablas, fórmulas).
    parser_preference: str = "native"
    docling_ocr: bool = False                     # OCR local de Docling (sin red): ruta offline para escaneados
    docling_artifacts_path: str | None = None     # modelos de Docling pre-descargados (despliegues sin red)
    # VLM para describir figuras en ingesta. Vacío => figuras solo con su caption (si lo tienen).
    ai_vision_model: str = ""
    vision_max_images_per_doc: int = 40
    vision_min_image_bytes: int = 2048            # iconos/viñetas por debajo se descartan
    vision_min_image_side: int = 64
    vision_max_image_bytes: int = 3_750_000       # límite por imagen de Bedrock Converse
    vision_max_image_pixels: int = 40_000_000     # defensa ante bombas de descompresión
    # Resumen de tablas con el modelo de generación (cifras verificadas contra la tabla).
    ingest_table_summaries: bool = False
    # Análisis de ecuaciones con el modelo de generación y contexto cercano (variables, qué calcula, dónde se usa).
    ingest_equation_analysis: bool = False
    # Consulta: adjuntar imágenes de figuras recuperadas al generador si tiene visión. auto | on | off
    rag_vlm_enhanced: str = "auto"
    rag_vlm_max_images: int = 3

    # RAG-05 GraphRAG. Modelo de extracción de entidades/relaciones (vía AIGateway.generate, filtrado por la
    # política del tenant). Vacío => sin grafo aunque el tenant lo tenga habilitado (con advertencia).
    ai_graph_model: str = ""
    graph_max_chunks_per_doc: int = 200
    # Consulta: entidades y relaciones de la evidencia seleccionada que se añaden al prompt (tokens aprox.).
    rag_graph_context_tokens: int = 500

    pipeline_version: str = "ingest-2026.11.3"
    log_level: str = "INFO"


@lru_cache
def get_settings() -> Settings:
    return Settings()
