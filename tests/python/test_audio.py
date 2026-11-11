"""ADR-030: grabaciones de audio → transcripción con tiempos → chunks `audio` → citas reproducibles.

BD y S3 reales (compose); el transcriptor es falso (sin red). El adaptador de Amazon Transcribe se prueba con un
cliente falso que devuelve la salida real del servicio (`results.items`).
"""

from __future__ import annotations

import io
import json
import struct

import pytest
from ragsis_ai.types import DataClass, TenantAIPolicy
from ragsis_core.settings import get_settings
from ragsis_ingest.chunker import Chunker
from ragsis_ingest.pipeline import IngestPipeline
from ragsis_ingest.reindex import enqueue, plan_versions
from ragsis_ingest.transcription import (
    AmazonTranscribe,
    Segment,
    Transcript,
    TranscriptionUnavailable,
    clock,
    segments_from_items,
    transcript_blocks,
)
from ragsis_ingest.validation import ValidationError, sniff_audio, validate
from ragsis_rag.orchestrator import QueryOrchestrator
from ragsis_rag.prompting import modality_preference


def wav(seconds: float = 0.1) -> bytes:
    data = b"\x00\x00" * int(8000 * seconds)
    fmt = struct.pack("<4sIHHIIHH", b"fmt ", 16, 1, 1, 8000, 16000, 2, 16)
    return b"RIFF" + struct.pack("<I", 4 + len(fmt) + 8 + len(data)) + b"WAVE" + fmt + b"data" + struct.pack(
        "<I", len(data)) + data


MP3 = b"ID3\x04\x00\x00\x00\x00\x00\x0a" + b"\x00" * 10 + b"\xff\xfb\x90\x00" + b"\x00" * 400
M4A = b"\x00\x00\x00\x20ftypM4A \x00\x00\x00\x00M4A mp42isom" + b"\x00" * 200
MP4_VIDEO = b"\x00\x00\x00\x20ftypqt  \x00\x00\x00\x00qt  " + b"\x00" * 200
SEGMENTS = [
    Segment(0.0, 6.5, "Buenos días a todos, empezamos la reunión de presupuesto.", "Hablante 1"),
    Segment(7.0, 15.2, "El presupuesto de mercadeo para el próximo año queda en 480 millones de pesos.", "Hablante 2"),
    Segment(15.8, 24.0, "La campaña de lanzamiento en Barranquilla empieza el 3 de marzo.", "Hablante 1"),
]


class FakeTranscriber:
    model_id = "aws-transcribe@v1"

    def __init__(self, segments=SEGMENTS, duration: float = 24.0) -> None:
        self.calls: list[tuple] = []
        self.segments, self.duration = segments, duration

    def transcribe(self, bucket, key, media_format, output_prefix) -> Transcript:
        self.calls.append((bucket, key, media_format, output_prefix))
        return Transcript(self.model_id, list(self.segments), "es-US", self.duration, 0.93, 2)


# ---------------------------------------------------------------- validación
def test_sniff_audio_containers():
    assert sniff_audio(wav()[:2048]) == "wav" and sniff_audio(MP3) == "mp3" and sniff_audio(M4A) == "m4a"
    assert sniff_audio(b"fLaC" + b"\x00" * 40) == "flac" and sniff_audio(b"OggS" + b"\x00" * 40) == "ogg"
    assert sniff_audio(b"\xff\xfb\x90\x00" + b"\x00" * 40) == "mp3"      # MP3 sin etiqueta ID3
    assert sniff_audio(MP4_VIDEO) is None and sniff_audio(b"%PDF-1.7") is None and sniff_audio(b"hola") is None


def test_validate_audio_checks_declared_type_against_the_container():
    w = wav()
    info = validate(w, "reunion.wav", "audio/wav", len(w), 10**7)
    assert (info.kind, info.audio_format) == ("audio", "wav")
    assert validate(MP3, "a.mp3", "audio/mpeg", len(MP3), 10**7).audio_format == "mp3"
    assert validate(M4A, "nota.m4a", "audio/mp4", len(M4A), 10**7).audio_format == "m4a"
    with pytest.raises(ValidationError) as e:
        validate(w, "reunion.mp3", "audio/mpeg", len(w), 10**7)          # WAV declarado como MP3
    assert e.value.code == "mime_mismatch"
    with pytest.raises(ValidationError):
        validate(w, "reunion.pdf", "application/pdf", len(w), 10**7)
    with pytest.raises(ValidationError) as e:
        validate(MP4_VIDEO, "video.mov", "audio/mp4", len(MP4_VIDEO), 10**7)   # video: no admitido
    assert e.value.code == "unsupported_type"


# ---------------------------------------------------------------- segmentos y tramos
def _word(text, t0, t1, spk="spk_0", conf=0.99):
    return {"type": "pronunciation", "start_time": str(t0), "end_time": str(t1), "speaker_label": spk,
            "alternatives": [{"content": text, "confidence": str(conf)}]}


def _punct(text):
    return {"type": "punctuation", "alternatives": [{"content": text, "confidence": "0.0"}]}


ITEMS = [_word("Buenos", 0.0, 0.4), _word("días", 0.4, 0.8), _punct("."),
         _word("Gracias", 1.2, 1.6, "spk_1"), _punct(","), _word("empecemos", 1.6, 2.2, "spk_1"), _punct("."),
         _word("mmm", 2.3, 2.4, "spk_1", conf=0.1),
         _word("Tras", 9.0, 9.3, "spk_1"), _word("la", 9.3, 9.4, "spk_1"), _word("pausa", 9.4, 9.9, "spk_1"),
         {"type": "pronunciation", "alternatives": [{"content": "roto"}]}]


def test_segments_split_on_speaker_change_and_long_pause_and_drop_low_confidence():
    segs, confs, dropped = segments_from_items(ITEMS, 0.4)
    assert [(s.start, s.end, s.text, s.speaker) for s in segs] == [
        (0.0, 0.8, "Buenos días.", "Hablante 1"),
        (1.2, 2.2, "Gracias, empecemos.", "Hablante 2"),
        (9.0, 9.9, "Tras la pausa", "Hablante 2"),
    ]
    assert dropped == 1 and len(confs) == 7
    assert segments_from_items([], 0.4) == ([], [], 0)


def test_blocks_never_split_a_segment_and_keep_exact_time_ranges():
    tr = Transcript("fake", SEGMENTS, "es-US", 24.0)
    [one] = transcript_blocks(tr)
    assert one.kind == "audio" and (one.meta["t_start"], one.meta["t_end"]) == (0.0, 24.0)
    assert one.meta["speakers"] == ["Hablante 1", "Hablante 2"]
    assert one.text.split("\n")[1] == "[00:07] Hablante 2: El presupuesto de mercadeo para el próximo año queda en 480 " \
                                      "millones de pesos."
    blocks = transcript_blocks(tr, target_tokens=20)
    assert [(b.meta["t_start"], b.meta["t_end"]) for b in blocks] == [(0.0, 6.5), (7.0, 15.2), (15.8, 24.0)]
    chunks = Chunker().chunk(blocks)
    assert [c.kind for c in chunks] == ["audio"] * 3 and chunks[1].meta["t_start"] == 7.0
    assert chunks[0].page_start is None
    assert clock(75) == "01:15" and clock(3725) == "1:02:05"
    assert Transcript.from_json(tr.to_json()).segments == SEGMENTS


def test_modality_cue_for_recordings():
    assert modality_preference("¿Qué se dijo en la grabación sobre el presupuesto?") == ("audio",)
    assert modality_preference("What did they agree on the call?") == ("audio",)


# ---------------------------------------------------------------- adaptador de Amazon Transcribe
class FakeTranscribeClient:
    def __init__(self, statuses=("IN_PROGRESS", "COMPLETED")) -> None:
        self.statuses = list(statuses)
        self.started: dict = {}
        self.deleted: list[str] = []

    def start_transcription_job(self, **kw):
        self.started = kw

    def get_transcription_job(self, TranscriptionJobName):  # noqa: N803 - firma de boto3
        status = self.statuses.pop(0) if len(self.statuses) > 1 else self.statuses[0]
        return {"TranscriptionJob": {"TranscriptionJobStatus": status, "LanguageCode": "es-US",
                                     "FailureReason": "audio dañado"}}

    def delete_transcription_job(self, TranscriptionJobName):  # noqa: N803
        self.deleted.append(TranscriptionJobName)


class FakeS3:
    def __init__(self, body: dict) -> None:
        self.body, self.deleted = body, []

    def get_object(self, Bucket, Key):  # noqa: N803
        return {"Body": io.BytesIO(json.dumps(self.body).encode())}

    def delete_object(self, Bucket, Key):  # noqa: N803
        self.deleted.append(Key)


def test_transcribe_adapter_reads_the_job_output_and_cleans_up(monkeypatch):
    monkeypatch.setattr("ragsis_ingest.transcription.time.sleep", lambda _s: None)
    client, s3 = FakeTranscribeClient(), FakeS3({"results": {"items": ITEMS}})
    tr = AmazonTranscribe(timeout_s=30, min_conf=0.4, client=client, s3=s3).transcribe(
        "b", "tenants/x/raw/a.mp3", "mp3", "tenants/x/assets/d/v/")
    assert tr.provider == "aws-transcribe@v1" and tr.language == "es-US" and len(tr.segments) == 3
    assert tr.duration == 9.9 and tr.dropped_words == 1 and 0.9 < tr.mean_confidence <= 1
    p = client.started
    assert p["Media"] == {"MediaFileUri": "s3://b/tenants/x/raw/a.mp3"} and p["MediaFormat"] == "mp3"
    assert p["IdentifyLanguage"] is True and "es-US" in p["LanguageOptions"] and "LanguageCode" not in p
    assert p["Settings"]["ShowSpeakerLabels"] is True
    # La salida cruda queda dentro del prefijo del tenant y se borra; el job también.
    assert p["OutputBucketName"] == "b" and p["OutputKey"].startswith("tenants/x/assets/d/v/ragsis-")
    assert s3.deleted == [p["OutputKey"]] and client.deleted == [p["TranscriptionJobName"]]


def test_transcribe_adapter_failure_is_retryable(monkeypatch):
    monkeypatch.setattr("ragsis_ingest.transcription.time.sleep", lambda _s: None)
    client = FakeTranscribeClient(statuses=("FAILED",))
    with pytest.raises(TranscriptionUnavailable, match="audio dañado"):
        AmazonTranscribe(timeout_s=30, client=client, s3=FakeS3({})).transcribe("b", "k", "mp3", "p/")
    assert len(client.deleted) == 1


# ---------------------------------------------------------------- integración
def _one(owner, sql, *params):
    return owner.execute(sql, params).fetchone()


def test_recording_is_transcribed_indexed_and_cited_with_its_time(make_tenant, s3, worker_pool, app_pool, owner):
    t = make_tenant("audio")
    fake = FakeTranscriber()
    pipe = IngestPipeline(pool=worker_pool, transcriber=fake)
    doc, ver, msg = t.add_document(s3, "reunion.wav", wav(), "audio/wav", title="Reunión de presupuesto")
    assert pipe.handle(msg) == "indexed"
    [(bucket, key, fmt, prefix)] = fake.calls
    assert key == f"tenants/{t.org}/raw/{doc}/{ver}/reunion.wav" and fmt == "wav"
    assert prefix == f"tenants/{t.org}/assets/{doc}/{ver}/"

    chunk = _one(owner, "SELECT kind, text, meta, page_start FROM chunks WHERE version_id=%s", ver)
    assert chunk["kind"] == "audio" and chunk["page_start"] is None
    assert (chunk["meta"]["t_start"], chunk["meta"]["t_end"]) == (0.0, 24.0)
    assert "[00:07] Hablante 2: El presupuesto de mercadeo" in chunk["text"]
    v = _one(owner, "SELECT duration_seconds, transcription_provider, transcription_language, parser, page_count "
                    "FROM document_versions WHERE id=%s", ver)
    assert (v["duration_seconds"], v["transcription_provider"], v["transcription_language"]) == (
        24.0, "aws-transcribe@v1", "es-US")
    assert v["parser"] == "audio+aws-transcribe@v1" and v["page_count"] == 0
    assert _one(owner, "SELECT quantity FROM usage_events WHERE organization_id=%s AND kind='audio_seconds'",
                t.org)["quantity"] == 24
    audit = _one(owner, "SELECT metadata FROM audit_events WHERE organization_id=%s AND action='document.indexed'", t.org)
    assert audit["metadata"]["audio"] == {"provider": "aws-transcribe@v1", "seconds": 24.0, "language": "es-US",
                                          "segments": 3, "mean_confidence": 0.93, "dropped_words": 2}
    # La transcripción normalizada queda como activo del tenant.
    saved = s3.get_object(Bucket="ragsis-test", Key=f"{prefix}transcript.json")["Body"].read()
    assert Transcript.from_json(saved).segments == SEGMENTS

    r = QueryOrchestrator(pool=app_pool).run(t.claims(), "¿En cuánto queda el presupuesto de mercadeo?")
    assert not r.abstained and "480 millones" in r.answer
    cit = r.citations[0]
    assert cit["kind"] == "audio" and (cit["t_start"], cit["t_end"]) == (0.0, 24.0) and cit["page"] is None
    assert cit["filename"] == "reunion.wav"

    # Reindexado completo: reutiliza la transcripción guardada, no vuelve a transcribir ni a cobrar.
    model = get_settings().ai_embedding_model
    [res] = enqueue(t.org, plan_versions(t.org, "full", model, False, pool=worker_pool), "full", model, inline=True,
                    pool=worker_pool, pipeline=pipe)
    assert res == "reindexed:full:1" and len(fake.calls) == 1
    assert _one(owner, "SELECT count(*) AS n FROM usage_events WHERE organization_id=%s AND kind='audio_seconds'",
                t.org)["n"] == 1


def test_long_recording_is_split_into_timed_chunks_and_cites_the_right_one(make_tenant, s3, worker_pool, app_pool, owner):
    segs = [Segment(i * 30.0, i * 30.0 + 28.0, f"Punto {i + 1} del orden del día sobre logística y bodegas, sin "
                                               f"novedades en el inventario de la sede.", "Hablante 1") for i in range(40)]
    segs[25] = Segment(750.0, 778.0, "La auditoría externa la hará la firma Castaño y Asociados en el mes de julio.",
                       "Hablante 2")
    t = make_tenant("audiolong")
    pipe = IngestPipeline(pool=worker_pool, transcriber=FakeTranscriber(segs, 1198.0))
    _, ver, msg = t.add_document(s3, "junta.mp3", MP3, "audio/mpeg")
    assert pipe.handle(msg) == "indexed"
    rows = owner.execute("SELECT (meta->>'t_start')::float AS a, (meta->>'t_end')::float AS b FROM chunks "
                         "WHERE version_id=%s ORDER BY ordinal", (ver,)).fetchall()
    assert len(rows) > 2 and rows[0]["a"] == 0.0 and rows[-1]["b"] == 1198.0
    assert all(x["b"] <= y["a"] for x, y in zip(rows, rows[1:], strict=False))        # tramos sin solaparse
    r = QueryOrchestrator(pool=app_pool).run(t.claims(), "¿Quién hará la auditoría externa?")
    cit = r.citations[0]
    assert "Castaño" in r.answer and cit["t_start"] <= 750.0 <= cit["t_end"]


def test_audio_without_transcriber_or_for_restricted_tenant_is_rejected_clearly(make_tenant, s3, worker_pool, owner):
    t = make_tenant("audionone")
    _, ver, msg = t.add_document(s3, "nota.m4a", M4A, "audio/mp4")
    assert IngestPipeline(pool=worker_pool).handle(msg) == "failed:transcription_required"
    v = _one(owner, "SELECT status, error_code FROM document_versions WHERE id=%s", ver)
    assert (v["status"], v["error_code"]) == ("failed", "transcription_required")

    r = make_tenant("audiorestricted", data_class=DataClass.RESTRICTED.value)
    fake = FakeTranscriber()
    _, ver2, msg2 = r.add_document(s3, "llamada.wav", wav(), "audio/wav")
    assert IngestPipeline(pool=worker_pool, transcriber=fake).handle(msg2) == "failed:model_policy_violation"
    assert fake.calls == []                                             # el audio no salió del entorno
    assert _one(owner, "SELECT count(*) AS n FROM chunks WHERE version_id=%s", ver2)["n"] == 0
    assert TenantAIPolicy(DataClass.RESTRICTED).data_class == "restricted"


def test_silent_or_too_long_recordings_fail_without_indexing(make_tenant, s3, worker_pool, owner, monkeypatch):
    t = make_tenant("audioedge")
    _, _, msg = t.add_document(s3, "silencio.wav", wav(), "audio/wav")
    assert IngestPipeline(pool=worker_pool, transcriber=FakeTranscriber([], 30.0)).handle(msg) == "failed:no_speech_detected"
    monkeypatch.setenv("AUDIO_MAX_SECONDS", "10")
    get_settings.cache_clear()
    try:
        _, _, msg2 = t.add_document(s3, "larga.wav", wav(0.2), "audio/wav")
        assert IngestPipeline(pool=worker_pool, transcriber=FakeTranscriber()).handle(msg2) == "failed:audio_too_long"
    finally:
        monkeypatch.delenv("AUDIO_MAX_SECONDS")
        get_settings.cache_clear()
    assert _one(owner, "SELECT count(*) AS n FROM chunks WHERE organization_id=%s", t.org)["n"] == 0
