"""Escaneo antimalware. ClamAV vía protocolo clamd INSTREAM; 'none' solo admitido en local."""

from __future__ import annotations

import socket
import struct

from ragsis_core.settings import get_settings

from .validation import ValidationError


class ScannerUnavailable(Exception):
    """Error transitorio: el job se reintenta."""


def scan(data: bytes) -> None:
    s = get_settings()
    if s.malware_scanner == "none":
        if s.ragsis_env not in ("local", "test"):
            raise ScannerUnavailable("MALWARE_SCANNER=none no permitido fuera de local")
        return
    if s.malware_scanner == "clamav":
        _clamav(data, s.clamav_host, s.clamav_port)
        return
    raise ScannerUnavailable(f"scanner desconocido {s.malware_scanner}")


def _clamav(data: bytes, host: str, port: int, chunk: int = 64 * 1024) -> None:
    try:
        with socket.create_connection((host, port), timeout=30) as sock:
            sock.sendall(b"zINSTREAM\0")
            for i in range(0, len(data), chunk):
                part = data[i:i + chunk]
                sock.sendall(struct.pack("!L", len(part)) + part)
            sock.sendall(struct.pack("!L", 0))
            reply = sock.recv(4096).decode("utf-8", "replace").strip("\0\n ")
    except OSError as exc:
        raise ScannerUnavailable(f"clamd: {exc}") from exc
    if reply.endswith("OK"):
        return
    if "FOUND" in reply:
        raise ValidationError("malware_detected", reply.split(":", 1)[-1].strip()[:120])
    raise ScannerUnavailable(f"respuesta clamd inesperada: {reply[:120]}")
