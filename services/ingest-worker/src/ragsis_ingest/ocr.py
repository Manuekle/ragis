"""OCR para páginas sin texto digital (PDFs escaneados). Ruta inicial F3: Amazon Textract asíncrono
sobre el objeto ya almacenado en S3 (el archivo no sale de AWS ni pasa por el worker otra vez).

Quality gate: se descartan líneas con confianza < umbral y se registra la confianza media; si una
página queda sin texto confiable, no aporta evidencia (el RAG se abstiene en vez de inventar).
La política de datos del tenant se valida antes de invocar el servicio (Textract es cloud).
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from functools import cached_property
from typing import Protocol

from ragsis_core.settings import get_settings


@dataclass
class OcrResult:
    provider: str
    pages: dict[int, list[str]] = field(default_factory=dict)   # página -> líneas confiables
    mean_confidence: float = 0.0
    dropped_lines: int = 0

    @property
    def pages_processed(self) -> int:
        return len(self.pages)


class OcrProvider(Protocol):
    model_id: str

    def recognize(self, bucket: str, key: str, pages: list[int]) -> OcrResult: ...


class OcrUnavailable(Exception):
    """Fallo transitorio del servicio OCR (reintentable)."""


class TextractOcr:
    model_id = "aws-textract@v1"

    def __init__(self, timeout_s: int | None = None, min_conf: float | None = None, client=None) -> None:
        s = get_settings()
        self.timeout_s = timeout_s or s.ocr_timeout_seconds
        self.min_conf = min_conf if min_conf is not None else s.ocr_min_line_confidence
        self._client_override = client

    @cached_property
    def client(self):
        if self._client_override is not None:
            return self._client_override
        import boto3

        return boto3.client("textract", region_name=get_settings().aws_region)

    def recognize(self, bucket: str, key: str, pages: list[int]) -> OcrResult:
        from botocore.exceptions import BotoCoreError, ClientError

        wanted = set(pages)
        try:
            job_id = self.client.start_document_text_detection(
                DocumentLocation={"S3Object": {"Bucket": bucket, "Name": key}})["JobId"]
            deadline = time.monotonic() + self.timeout_s
            delay = 2.0
            while True:
                resp = self.client.get_document_text_detection(JobId=job_id, MaxResults=1000)
                status = resp["JobStatus"]
                if status == "SUCCEEDED":
                    break
                if status == "FAILED":
                    raise OcrUnavailable(resp.get("StatusMessage", "textract FAILED"))
                if time.monotonic() > deadline:
                    raise OcrUnavailable("timeout esperando Textract")
                time.sleep(delay)
                delay = min(delay * 1.5, 15.0)
            result = OcrResult(self.model_id)
            confs: list[float] = []
            while True:
                for b in resp.get("Blocks", []):
                    if b.get("BlockType") != "LINE":
                        continue
                    page = int(b.get("Page", 1))
                    if wanted and page not in wanted:
                        continue
                    conf = float(b.get("Confidence", 0.0))
                    if conf < self.min_conf:
                        result.dropped_lines += 1
                        continue
                    confs.append(conf)
                    result.pages.setdefault(page, []).append(b.get("Text", ""))
                token = resp.get("NextToken")
                if not token:
                    break
                resp = self.client.get_document_text_detection(JobId=job_id, MaxResults=1000, NextToken=token)
            result.mean_confidence = round(sum(confs) / len(confs), 2) if confs else 0.0
            return result
        except (ClientError, BotoCoreError) as exc:
            raise OcrUnavailable(f"textract: {exc}") from exc


def get_ocr_provider() -> OcrProvider | None:
    name = get_settings().ocr_provider
    if name == "textract":
        return TextractOcr()
    return None
