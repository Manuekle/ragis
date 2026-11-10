"""Logging JSON estructurado con redacción de campos sensibles."""

from __future__ import annotations

import json
import logging
import re
import sys
import time

_REDACT_KEYS = {"question", "prompt", "answer", "text", "authorization", "token", "password", "secret"}
_EMAIL_RE = re.compile(r"[\w.+-]+@[\w-]+\.[\w.]+")


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload = {
            "ts": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(record.created)),
            "level": record.levelname,
            "logger": record.name,
            "msg": _EMAIL_RE.sub("[email]", record.getMessage()),
        }
        extra = getattr(record, "ctx", None)
        if isinstance(extra, dict):
            for k, v in extra.items():
                payload[k] = "[redacted]" if k.lower() in _REDACT_KEYS else v
        if record.exc_info:
            payload["exc"] = self.formatException(record.exc_info)
        return json.dumps(payload, ensure_ascii=False, default=str)


def setup_logging(level: str = "INFO") -> None:
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(JsonFormatter())
    root = logging.getLogger()
    root.handlers[:] = [handler]
    root.setLevel(level)


def log(logger: logging.Logger, level: int, msg: str, **ctx) -> None:
    logger.log(level, msg, extra={"ctx": ctx})
