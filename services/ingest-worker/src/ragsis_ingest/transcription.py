"""Transcripción de grabaciones de audio (ADR-030). Ruta inicial: Amazon Transcribe asíncrono sobre el objeto ya
almacenado en S3 (el archivo no vuelve a pasar por el worker), mismo patrón que el OCR con Textract.

- El proveedor devuelve segmentos {inicio, fin, texto, hablante}; aquí se agrupan en tramos acotados por tokens sin
  partir un segmento, así cada chunk conserva un rango de tiempo exacto que la cita puede reproducir.
- Quality gate: las palabras con confianza menor al umbral se descartan; un tramo sin texto confiable no se indexa.
- La política de datos del tenant se valida antes de invocar el servicio (Transcribe es cloud): un tenant
  restringido no puede subir audio mientras no haya un transcriptor local.
- La transcripción normalizada se guarda como activo derivado del tenant (JSON) para no pagarla otra vez en un
  reindexado completo.
"""

from __future__ import annotations

import contextlib
import json
import time
import uuid
from dataclasses import asdict, dataclass, field
from functools import cached_property
from typing import Protocol

from ragsis_core.settings import get_settings
from ragsis_core.text import estimate_tokens, normalize

from .parsers.model import Block, ParsedDocument

AUDIO_FORMATS = {"mp3": "mp3", "wav": "wav", "flac": "flac", "ogg": "ogg", "m4a": "mp4"}
TARGET_TOKENS = 320
MAX_GAP_SECONDS = 1.5
MAX_SEGMENT_SECONDS = 45.0
_SENTENCE_END = (".", "?", "!", "…")


@dataclass
class Segment:
    start: float
    end: float
    text: str
    speaker: str = ""


@dataclass
class Transcript:
    provider: str
    segments: list[Segment] = field(default_factory=list)
    language: str = ""
    duration: float = 0.0
    mean_confidence: float = 0.0
    dropped_words: int = 0
    reused: bool = False

    def to_json(self) -> str:
        return json.dumps({"v": 1, "provider": self.provider, "language": self.language, "duration": self.duration,
                           "mean_confidence": self.mean_confidence, "dropped_words": self.dropped_words,
                           "segments": [asdict(s) for s in self.segments]}, ensure_ascii=False)

    @classmethod
    def from_json(cls, raw: str | bytes) -> Transcript:
        d = json.loads(raw)
        if d.get("v") != 1:
            raise ValueError("versión de transcripción no soportada")
        return cls(d["provider"], [Segment(float(s["start"]), float(s["end"]), str(s["text"]), str(s.get("speaker", "")))
                                   for s in d["segments"]],
                   d.get("language", ""), float(d.get("duration", 0.0)), float(d.get("mean_confidence", 0.0)),
                   int(d.get("dropped_words", 0)))


class TranscriptionProvider(Protocol):
    model_id: str

    def transcribe(self, bucket: str, key: str, media_format: str, output_prefix: str) -> Transcript: ...


class TranscriptionUnavailable(Exception):
    """Fallo transitorio del servicio de transcripción (reintentable)."""


def clock(seconds: float) -> str:
    s = int(max(seconds, 0))
    h, m, sec = s // 3600, (s % 3600) // 60, s % 60
    return f"{h}:{m:02d}:{sec:02d}" if h else f"{m:02d}:{sec:02d}"


def speaker_label(raw: str) -> str:
    """'spk_0' → 'Hablante 1'. Etiqueta estable y neutra: el proveedor no sabe quién habla."""
    digits = "".join(ch for ch in raw if ch.isdigit())
    return f"Hablante {int(digits) + 1}" if digits else ""


def segments_from_items(items: list[dict], min_confidence: float) -> tuple[list[Segment], list[float], int]:
    """Segmentos a partir de la lista de palabras de Transcribe (`results.items`).

    Corta al cambiar de hablante, tras una pausa larga, o al cerrar una oración cuando el segmento ya es largo.
    Devuelve (segmentos, confianzas aceptadas, palabras descartadas por baja confianza)."""
    out: list[Segment] = []
    confs: list[float] = []
    dropped = 0
    words: list[str] = []
    start = end = 0.0
    speaker = ""

    def close() -> None:
        nonlocal words
        text = normalize(" ".join(words))
        if text:
            out.append(Segment(round(start, 2), round(end, 2), text, speaker_label(speaker)))
        words = []

    for it in items:
        alt = (it.get("alternatives") or [{}])[0]
        content = str(alt.get("content") or "")
        if not content:
            continue
        if it.get("type") == "punctuation":
            if words:
                words[-1] += content
                if content in _SENTENCE_END and end - start >= MAX_SEGMENT_SECONDS:
                    close()
            continue
        try:
            t0, t1 = float(it["start_time"]), float(it["end_time"])
            conf = float(alt.get("confidence") or 0.0)
        except (KeyError, TypeError, ValueError):
            continue
        if conf < min_confidence:
            dropped += 1
            continue
        spk = str(it.get("speaker_label") or "")
        if words and (spk != speaker or t0 - end > MAX_GAP_SECONDS
                      or (words[-1].endswith(_SENTENCE_END) and t0 - end > 0.6)):
            close()
        if not words:
            start, speaker = t0, spk
        words.append(content)
        end = t1
        confs.append(conf)
    close()
    return out, confs, dropped


def transcript_blocks(tr: Transcript, target_tokens: int = TARGET_TOKENS) -> list[Block]:
    """Tramos de audio como bloques `audio`: nunca se parte un segmento, así el rango de tiempo es exacto."""
    blocks: list[Block] = []
    window: list[Segment] = []
    tokens = 0

    def flush() -> None:
        nonlocal window, tokens
        if not window:
            return
        lines = [f"[{clock(s.start)}] {s.speaker + ': ' if s.speaker else ''}{s.text}" for s in window]
        speakers = list(dict.fromkeys(s.speaker for s in window if s.speaker))
        blocks.append(Block("audio", "\n".join(lines), meta={
            "t_start": window[0].start, "t_end": window[-1].end, **({"speakers": speakers} if speakers else {})}))
        window, tokens = [], 0

    for seg in tr.segments:
        cost = estimate_tokens(seg.text) + 6
        if window and tokens + cost > target_tokens:
            flush()
        window.append(seg)
        tokens += cost
    flush()
    return blocks


def transcript_document(tr: Transcript) -> ParsedDocument:
    warnings = []
    if tr.dropped_words:
        warnings.append(f"transcription_low_confidence_words: {tr.dropped_words}")
    return ParsedDocument(f"audio+{tr.provider}", "1", transcript_blocks(tr), page_count=0, warnings=warnings)


class AmazonTranscribe:
    model_id = "aws-transcribe@v1"

    def __init__(self, timeout_s: int | None = None, min_conf: float | None = None, client=None, s3=None) -> None:
        s = get_settings()
        self.timeout_s = timeout_s or s.transcription_timeout_seconds
        self.min_conf = min_conf if min_conf is not None else s.transcription_min_word_confidence
        self._client_override = client
        self._s3_override = s3

    @cached_property
    def client(self):
        if self._client_override is not None:
            return self._client_override
        import boto3

        return boto3.client("transcribe", region_name=get_settings().aws_region)

    @cached_property
    def s3(self):
        if self._s3_override is not None:
            return self._s3_override
        from ragsis_core.aws import s3_client

        return s3_client()

    def transcribe(self, bucket: str, key: str, media_format: str, output_prefix: str) -> Transcript:
        from botocore.exceptions import BotoCoreError, ClientError

        s = get_settings()
        job = f"ragsis-{uuid.uuid4().hex}"
        out_key = f"{output_prefix}{job}.raw.json"
        params: dict = {"TranscriptionJobName": job, "Media": {"MediaFileUri": f"s3://{bucket}/{key}"},
                        "MediaFormat": media_format, "OutputBucketName": bucket, "OutputKey": out_key}
        if s.transcription_language:
            params["LanguageCode"] = s.transcription_language
        else:
            params["IdentifyLanguage"] = True
            options = [x.strip() for x in s.transcription_language_options.split(",") if x.strip()]
            if options:
                params["LanguageOptions"] = options
        if s.transcription_max_speakers >= 2:
            params["Settings"] = {"ShowSpeakerLabels": True, "MaxSpeakerLabels": min(s.transcription_max_speakers, 30)}
        try:
            self.client.start_transcription_job(**params)
            deadline = time.monotonic() + self.timeout_s
            delay = 3.0
            while True:
                info = self.client.get_transcription_job(TranscriptionJobName=job)["TranscriptionJob"]
                status = info["TranscriptionJobStatus"]
                if status == "COMPLETED":
                    break
                if status == "FAILED":
                    raise TranscriptionUnavailable(info.get("FailureReason", "transcribe FAILED"))
                if time.monotonic() > deadline:
                    raise TranscriptionUnavailable("timeout esperando Transcribe")
                time.sleep(delay)
                delay = min(delay * 1.5, 20.0)
            raw = json.loads(self.s3.get_object(Bucket=bucket, Key=out_key)["Body"].read())
            # La salida cruda del proveedor no se conserva: queda solo la transcripción normalizada del tenant.
            self.s3.delete_object(Bucket=bucket, Key=out_key)
        except (ClientError, BotoCoreError) as exc:
            raise TranscriptionUnavailable(f"transcribe: {exc}") from exc
        finally:
            # Limpieza best-effort: si falla, el job caduca solo en el servicio.
            with contextlib.suppress(Exception):
                self.client.delete_transcription_job(TranscriptionJobName=job)
        segments, confs, dropped = segments_from_items((raw.get("results") or {}).get("items") or [], self.min_conf)
        return Transcript(self.model_id, segments, str(info.get("LanguageCode") or s.transcription_language or ""),
                          round(segments[-1].end, 2) if segments else 0.0,
                          round(sum(confs) / len(confs), 4) if confs else 0.0, dropped)


def get_transcription_provider() -> TranscriptionProvider | None:
    if get_settings().transcription_provider == "transcribe":
        return AmazonTranscribe()
    return None
