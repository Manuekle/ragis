"""Candidate deadlines found at indexing time (ADR-038): literal quote, exact page, nothing invented."""

from datetime import date

import pytest
from ragsis_ingest.deadlines import candidates_in_sentence, find_candidates, looks_judicial, parse_number

COURT = ("JUZGADO SEGUNDO CIVIL DEL CIRCUITO DE BOGOTÁ", 1)


@pytest.mark.parametrize("words,expected", [
    (["tres"], 3), (["10"], 10), (["treinta", "y", "cinco"], 35), (["ciento", "veinte"], 120),
    (["veintiun"], 21), (["los"], None), (["y", "cinco"], None), ([], None),
])
def test_spanish_numbers(words, expected):
    assert parse_number(words) == expected


def test_term_of_days_defaults_to_business_days_and_keeps_the_literal_sentence():
    s = "Córrase traslado de la demanda al demandado por el término de diez (10) días, contados a partir de la notificación."
    [c] = candidates_in_sentence(s, 4, 0)
    assert (c.amount, c.unit, c.unit_assumed, c.trigger_hint, c.page) == (10, "business_days", True, "notification", 4)
    assert c.quote == s
    assert c.title == "Traslado"


@pytest.mark.parametrize("sentence,amount,unit", [
    ("Se concede un plazo de cinco días hábiles para que subsane la demanda.", 5, "business_days"),
    ("El accionado deberá cumplir dentro de los quince (15) días calendario siguientes.", 15, "calendar_days"),
    ("Se ordena reglamentar en un plazo de seis meses.", 6, "months"),
    ("La sanción se aplicará si en el término de un año no se cumple.", 1, "years"),
])
def test_units(sentence, amount, unit):
    [c] = candidates_in_sentence(sentence, 1, 0)
    assert (c.amount, c.unit, c.unit_assumed) == (amount, unit, False)


@pytest.mark.parametrize("sentence", [
    "Hace tres días se presentó el memorial.",
    "El Convenio entrará en vigor doce (12) meses después del registro de su ratificación.",
    "Las vacaciones colectivas van desde el 20 de diciembre hasta el 10 de enero.",
])
def test_narrative_durations_are_not_terms(sentence):
    assert candidates_in_sentence(sentence, 1, 0) == []


def test_fixed_date_and_legal_basis_keep_original_spelling():
    s = "Conforme al art. 118 del Código General del Proceso, el apoderado tiene plazo a más tardar el 5 de diciembre de 2026."
    [c] = candidates_in_sentence(s, 2, 0)
    assert (c.unit, c.amount, c.trigger_date) == ("fixed", None, date(2026, 12, 5))
    assert c.legal_basis == "art. 118 del Código General del Proceso"


def test_start_date_prefers_the_date_of_the_auto():
    s = ("29 de septiembre de 2025, dentro del término de tres días concedido en el auto inadmisorio del "
         "22 de septiembre de 2025.")
    [c] = candidates_in_sentence(s, None, 0)
    assert c.trigger_date == date(2025, 9, 22)


def test_quote_maps_back_through_characters_that_fold_longer():
    s = "Según el artículo 13 de la Ley 2213 de 2022… se notifica y corre el término de tres (3) días."
    [c] = candidates_in_sentence(s, 1, 0)
    assert c.legal_basis == "artículo 13 de la Ley 2213 de 2022"
    assert c.quote in s


def test_only_court_documents_and_deduplicated():
    sentence = "Se fija en lista por el término de diez (10) días para que cualquier ciudadano pueda intervenir."
    blocks = [COURT, ("AUTO. Expediente D-16.857. Notifíquese.", 1), (sentence, 3), (sentence, 3)]
    found = find_candidates(blocks)
    assert len(found) == 1 and found[0].page == 3 and found[0].block == 2
    # A contract with the same words is not a court document.
    assert find_candidates([("Contrato de arrendamiento", 1), (sentence, 1)]) == []
    assert find_candidates([("Contrato", 1), (sentence, 1)], require_judicial=False)
    assert looks_judicial(["Corte Constitucional", "Sentencia C-217 de 2026"])


# ---------------------------------------------------------------- worker integration (Postgres + S3 of compose)
AUTO = """JUZGADO SEGUNDO CIVIL DEL CIRCUITO DE BOGOTÁ

Radicado 11001310300220260045100. Demandante: Parra Rosas. Demandado: Constructora Andina S.A.S.

AUTO ADMISORIO

Por reunir los requisitos legales, el Despacho RESUELVE admitir la demanda. Córrase traslado al demandado por el término de veinte (20) días, contados a partir de la notificación de esta providencia, conforme al art. 369 del Código General del Proceso.

Notifíquese y cúmplase.
"""


def test_indexing_a_court_document_proposes_candidates_and_a_new_version_supersedes_them(make_tenant, s3, worker_pool, owner):
    from ragsis_ingest.pipeline import IngestPipeline

    t = make_tenant("terminos")
    pipeline = IngestPipeline(pool=worker_pool)
    doc, ver, msg = t.add_document(s3, "auto.txt", AUTO.encode(), "text/plain", title="Auto admisorio")
    assert pipeline.handle(msg) == "indexed"
    rows = owner.execute("SELECT * FROM deadline_candidates WHERE document_id=%s", (doc,)).fetchall()
    assert len(rows) == 1
    c = rows[0]
    assert (c["amount"], c["unit"], c["unit_assumed"], c["trigger_hint"], c["status"]) == (20, "business_days", True, "notification", "proposed")
    assert c["legal_basis"] == "art. 369 del Código General del Proceso"
    assert c["quote"] in AUTO.replace("\n", " ")
    chunk = owner.execute("SELECT text FROM chunks WHERE id=%s", (c["chunk_id"],)).fetchone()
    assert "veinte (20) días" in chunk["text"]

    # Rescan keeps the same candidate (idempotent by fingerprint).
    job = owner.execute("INSERT INTO ingestion_jobs (organization_id, kind, document_id, version_id, idempotency_key, params) "
                        "VALUES (%s,'reindex',%s,%s,'deadlines:test','{\"mode\":\"deadlines\"}') RETURNING id",
                        (t.org, doc, ver)).fetchone()["id"]
    from ragsis_ingest.pipeline import JobMessage

    assert pipeline.handle(JobMessage("reindex", t.org, doc, ver, job)) == "reindexed:deadlines:1"
    assert owner.execute("SELECT count(*) AS n FROM deadline_candidates WHERE document_id=%s", (doc,)).fetchone()["n"] == 1

    # A new version retires the open candidates of the old one.
    _, ver2, msg2 = t.add_document(s3, "auto-v2.txt", AUTO.replace("veinte (20)", "diez (10)").encode(), "text/plain",
                                   document_id=doc, version_no=2)
    assert pipeline.handle(msg2) == "indexed"
    by_version = {r["version_id"]: (r["status"], r["amount"]) for r in owner.execute(
        "SELECT version_id, status, amount FROM deadline_candidates WHERE document_id=%s", (doc,)).fetchall()}
    assert by_version == {ver: ("superseded", 20), ver2: ("proposed", 10)}


def test_documents_that_are_not_court_documents_propose_nothing(make_tenant, s3, worker_pool, owner):
    from ragsis_ingest.pipeline import IngestPipeline

    t = make_tenant("contrato")
    text = "CONTRATO DE ARRENDAMIENTO\n\nEl arrendatario pagará dentro de los cinco (5) días siguientes a cada mes.\n"
    doc, _, msg = t.add_document(s3, "contrato.txt", text.encode(), "text/plain")
    assert IngestPipeline(pool=worker_pool).handle(msg) == "indexed"
    assert owner.execute("SELECT count(*) AS n FROM deadline_candidates WHERE document_id=%s", (doc,)).fetchone()["n"] == 0


def test_sentences_do_not_break_on_legal_abbreviations():
    from ragsis_ingest.deadlines import split_sentences

    text = ("Constructora Andina S.A.S. fue notificada. Conforme al art. 369 del C.G.P. tiene veinte días. "
            "Ver núm. 2 del Dr. Ortiz. Notifíquese.")
    assert split_sentences(text) == [
        "Constructora Andina S.A.S. fue notificada.",
        "Conforme al art. 369 del C.G.P. tiene veinte días.",
        "Ver núm. 2 del Dr. Ortiz.",
        "Notifíquese.",
    ]
