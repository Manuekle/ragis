"""Documentos generados desde el chat (ADR-034): detección de intención, Markdown verificado y conversión a
PDF, Word, PowerPoint, CSV y Markdown. El flujo con BD comprueba que el archivo sale solo de evidencia autorizada,
se guarda privado y se convierte en cualquier formato."""

from __future__ import annotations

import csv
import io
import zipfile

import pytest
from docx import Document as DocxDocument
from pptx import Presentation
from pypdf import PdfReader
from ragsis_ai.types import Evidence
from ragsis_rag.documents.compose import chat_message, extractive_document, verify_markdown
from ragsis_rag.documents.intent import DocumentRequest, detect, resolve, topic_of
from ragsis_rag.documents.model import build_document, outline, slug, tidy_citations
from ragsis_rag.documents.render import render
from ragsis_rag.documents.render.csv import _guard
from ragsis_rag.documents.render.pptx import plan_slides
from ragsis_rag.documents.render.xlsx import number

MD = """# Política de teletrabajo: resumen

La política permite hasta **tres días** de trabajo remoto por semana [1]. La solicitud la aprueba el jefe directo [2].

## Quién puede teletrabajar

- Personal con contrato indefinido y más de 6 meses de antigüedad [1].
- Cargos sin atención presencial al público [1].
  - Excepción: soporte con turnos rotativos [3].

## Condiciones

| Concepto | Condición | Fuente |
|---|---|---|
| Días remotos | Hasta 3 por semana | [1] |
| Auxilio de conectividad | $120.000 mensuales | [2] |

## Pasos

1. Diligenciar el formato TH-07 [2].
2. Firmar el anexo ≥ 5 días antes del inicio [3].
"""
CITES = [
    {"n": 1, "title": "Política de Teletrabajo", "filename": "politica.pdf", "version_no": 3, "page": 4,
     "section": "Alcance", "effective_from": "2026-01-15", "kind": "text", "document_id": "d1"},
    {"n": 2, "title": "Procedimiento TH-07", "filename": "th07.docx", "version_no": 1, "page": 2, "section": "",
     "effective_from": None, "kind": "text", "document_id": "d2"},
    {"n": 3, "title": "Anexo de teletrabajo", "filename": "anexo.pdf", "version_no": 2, "page": None,
     "section": "Revocatoria", "effective_from": None, "kind": "text", "document_id": "d3"},
]


# ---------------------------------------------------------------------------------------------------- intención

@pytest.mark.parametrize("question,fmt,topic", [
    ("Hazme una presentación en PowerPoint sobre la política de teletrabajo", "pptx", "politica de teletrabajo"),
    ("Crea un informe en PDF de los plazos de reembolso", "pdf", "plazos de reembolso"),
    ("Exporta la tabla de tarifas a Excel", "xlsx", "tarifas"),
    ("Pasa los umbrales de compra a CSV", "csv", "umbrales de compra"),
    ("Arma una hoja de cálculo con los anticipos", "xlsx", "anticipos"),
    ("Genera un documento Word con el resumen del contrato C-217", "docx", "contrato c-217"),
    ("Prepara un resumen ejecutivo del reglamento interno", "pdf", "reglamento interno"),
    ("Make a table of all reimbursement deadlines", "xlsx", "all reimbursement deadlines"),
    ("Write a Word document about the travel policy", "docx", "travel policy"),
    ("Convert the onboarding checklist into slides", "pptx", "onboarding checklist"),
])
def test_detects_file_requests(question, fmt, topic):
    req = detect(question)
    assert req is not None and req.format == fmt and req.topic == topic and not req.explicit


@pytest.mark.parametrize("question", [
    "¿Qué dice el PDF de la póliza?",          # pregunta por un PDF existente
    "dame el PDF del contrato",                 # artículo definido: archivo existente, sin verbo de creación
    "Who must create a report on incidents?",   # interrogativa sobre el contenido
    "How do I export the report to PDF?",
    "Resume la política de viajes",             # un resumen en el chat, no un archivo
    "¿Cuál es el plazo de reembolso?",
])
def test_ordinary_questions_are_not_file_requests(question):
    assert detect(question) is None


def test_resolve_respects_explicit_choice_and_legacy_default():
    assert resolve("answer", "Hazme un PDF de la política") is None          # contrato anterior: nunca archivo
    forced = resolve("docx", "¿Cuál es la política de viajes?")
    assert forced and forced.format == "docx" and forced.explicit and forced.kind == "report"
    assert resolve("auto", "Hazme un PDF de la política").format == "pdf"
    with pytest.raises(ValueError):
        resolve("exe", "x")
    assert topic_of("Hazme una presentación") == "Hazme una presentación"     # sin tema: se busca con la pregunta


# ---------------------------------------------------------------------------------------------------- verificación

EVIDENCE = [
    Evidence(1, "La política de teletrabajo permite hasta tres días de trabajo remoto por semana para el personal con "
                "contrato indefinido y más de 6 meses de antigüedad.", "Política de Teletrabajo", 4),
    Evidence(2, "El auxilio de conectividad es de $120.000 mensuales. La solicitud se diligencia en el formato TH-07 y "
                "la aprueba el jefe directo.", "Procedimiento TH-07", 2),
]


def test_verifier_keeps_structure_and_drops_unsupported_claims():
    md = """```markdown
# Teletrabajo

La política permite hasta tres días de trabajo remoto por semana [1].

## Requisitos

- Contrato indefinido y más de 6 meses de antigüedad [1].
- Bono anual de 5 millones para quienes teletrabajan [2].
- El comité de bienestar organiza pausas activas diarias.

## Montos

| Concepto | Valor | Fuente |
|---|---|---|
| Auxilio de conectividad | $120.000 mensuales | [2] |
| Auxilio de transporte | $300.000 mensuales | [2] |
| Días remotos | 3 por semana | |

## Beneficios inventados

- Gimnasio gratis los viernes en todas las sedes [9].

## Sources

[1] Política de Teletrabajo
```"""
    out = verify_markdown(md, EVIDENCE)
    assert not out.abstained and out.cited == [1, 2]
    assert out.markdown.startswith("# Teletrabajo")
    assert "## Requisitos" in out.markdown and "6 meses" in out.markdown
    assert "5 millones" not in out.markdown                # cifra que no está en la fuente citada
    assert "pausas activas" not in out.markdown            # afirmación sin cita
    assert "Beneficios inventados" not in out.markdown     # sección vacía tras quitar la cita inválida [9]
    assert "$120.000" in out.markdown and "$300.000" not in out.markdown
    assert "| Días remotos" not in out.markdown            # fila sin cita
    assert "## Sources" not in out.markdown                # la lista de fuentes la genera el conversor


def test_verifier_abstains_without_support():
    assert verify_markdown("<ABSTAIN>", EVIDENCE).abstained
    out = verify_markdown("# Informe\n\n- Todo lo que no está en las fuentes [1].\n", EVIDENCE)
    assert out.abstained and out.reason == "no_verified_citations"


def test_extractive_document_is_verifiable():
    req = DocumentRequest("pdf", "report", "politica de teletrabajo", explicit=False)
    md = extractive_document("Crea un informe en PDF de la política de teletrabajo", req, EVIDENCE)
    assert md.startswith("# Informe: ")
    out = verify_markdown(md, EVIDENCE)
    assert not out.abstained and set(out.cited) <= {1, 2}
    table = extractive_document("Make a table of telework rules", DocumentRequest("csv", "table", "telework", False),
                                EVIDENCE)
    assert "| Document | Detail | Source |" in table


# ---------------------------------------------------------------------------------------------------- modelo y conversión

def test_markdown_model():
    doc = build_document(MD, CITES)
    assert doc.title == "Política de teletrabajo: resumen" and doc.language == "es"
    assert outline(doc) == ["Quién puede teletrabajar", "Condiciones", "Pasos"]
    assert [s.n for s in doc.sources] == [1, 2, 3]
    assert slug(doc.title) == "politica-de-teletrabajo-resumen"
    # Solo las fuentes citadas entran en la lista.
    assert [s.n for s in build_document("# T\n\nUno [2].\n", CITES).sources] == [2]


def test_pdf():
    out = render(MD, "pdf", CITES)
    assert out.mime == "application/pdf" and out.filename == "politica-de-teletrabajo-resumen.pdf"
    reader = PdfReader(io.BytesIO(out.data))
    text = "\n".join(p.extract_text() for p in reader.pages)
    assert "Política de teletrabajo" in text and "Fuentes" in text and "Procedimiento TH-07" in text
    assert reader.metadata.title == "Política de teletrabajo: resumen" and reader.metadata.author == "Ragis"
    def flat(items):
        return [t for o in items for t in (flat(o) if isinstance(o, list) else [o.title])]
    assert flat(reader.outline)[:2] == ["Política de teletrabajo: resumen", "Quién puede teletrabajar"]
    assert "Fuentes" in flat(reader.outline)


def test_docx():
    out = render(MD, "docx", CITES)
    d = DocxDocument(io.BytesIO(out.data))
    styles = [(p.style.name, p.text) for p in d.paragraphs]
    assert ("Title", "Política de teletrabajo: resumen") in styles
    assert ("Heading 1", "Quién puede teletrabajar") in styles and ("Heading 1", "Fuentes") in styles
    assert any(s.startswith("List Bullet 2") for s, _ in styles)
    assert len(d.tables) == 1 and d.tables[0].rows[0].cells[0].text == "Concepto"
    assert d.core_properties.title == "Política de teletrabajo: resumen" and d.core_properties.author == "Ragis"
    body = zipfile.ZipFile(io.BytesIO(out.data)).read("word/document.xml").decode()
    assert 'w:anchor="src_1"' in body and 'w:name="src_1"' in body       # cita → lista de fuentes
    assert "w:tblHeader" in body                                          # la cabecera se repite en cada página


def test_pptx():
    doc = build_document(MD, CITES, kind="presentation")
    out = render(MD, "pptx", CITES, kind="presentation")
    prs = Presentation(io.BytesIO(out.data))
    slides = list(prs.slides)
    assert len(slides) == plan_slides(doc) == 1 + 3 + 1            # portada + 3 secciones + fuentes
    texts = [" ".join(sh.text_frame.text for sh in s.shapes if sh.has_text_frame) for s in slides]
    assert "Política de teletrabajo: resumen" in texts[0]
    assert "Quién puede teletrabajar" in texts[1] and "Fuentes: [1] Política de Teletrabajo, p. 4" in texts[1]
    assert any(sh.has_table for sh in slides[2].shapes)
    assert "Fuentes" in texts[-1] and "Anexo de teletrabajo" in texts[-1]
    assert "Política de Teletrabajo — v3 · p. 4" in slides[1].notes_slide.notes_text_frame.text


def test_pptx_splits_long_sections():
    md = "# Deck\n\n## Muchas viñetas\n\n" + "\n".join(f"- Punto número {i} con su detalle [1]." for i in range(15))
    prs = Presentation(io.BytesIO(render(md, "pptx", CITES, kind="presentation").data))
    titles = [s.shapes[0].text_frame.text for s in list(prs.slides)[1:-1]]
    assert titles[0] == "Muchas viñetas" and all(t == "Muchas viñetas (cont.)" for t in titles[1:]) and len(titles) >= 3


def test_csv_tables_sources_and_injection():
    md = """# Tarifas

| Servicio | Valor | Fuente |
|---|---|---|
| Consulta | $50.000 | [1] |
| =HYPERLINK("http://x") | -5 | [2] |
"""
    out = render(md, "csv", CITES, kind="table")
    assert out.data.startswith("﻿".encode())
    rows = list(csv.reader(io.StringIO(out.data.decode("utf-8-sig"))))
    assert rows[0] == ["Servicio", "Valor", "Fuente"]
    assert rows[1] == ["Consulta", "$50.000", "Política de Teletrabajo, p. 4"]
    assert rows[2][0].startswith("'=") and rows[2][1] == "-5"
    assert b"\r\n" in out.data
    assert _guard("@SUM(A1)") == "'@SUM(A1)" and _guard("+57 300 000") == "+57 300 000"


def test_csv_without_tables_lists_points():
    rows = list(csv.reader(io.StringIO(render("# T\n\n## Alcance\n\n- Aplica a todos [1].\n", "csv", CITES).data
                                       .decode("utf-8-sig"))))
    assert rows == [["Section", "Content", "Sources"], ["Alcance", "Aplica a todos.", "Política de Teletrabajo, p. 4"]]


def test_csv_table_without_source_column_gets_one():
    md = "# Viáticos\n\n| Concepto | Límite |\n|---|---|\n| Hospedaje nacional [1] | 350000 pesos por noche [1][2] |\n"
    rows = list(csv.reader(io.StringIO(render(md, "csv", CITES, kind="table").data.decode("utf-8-sig"))))
    assert rows == [["Concepto", "Límite", "Fuente"],
                    ["Hospedaje nacional", "350000 pesos por noche", "Política de Teletrabajo, p. 4; Procedimiento TH-07, p. 2"]]


def test_citations_move_before_the_period_and_stay_attached():
    assert tidy_citations("Vigente desde 2026. [4]\nOtra. [1] [2]") == "Vigente desde 2026 [4].\nOtra [1][2]."
    assert tidy_citations("| Plazo. [3] |") == "| Plazo [3]. |"
    # Ordered-list markers and ellipses are not sentence ends with a citation.
    assert tidy_citations("1. [2] Diligenciar") == "1. [2] Diligenciar"
    assert tidy_citations("etc... [4]") == "etc... [4]"
    doc = build_document("# T\n\nPlazo de 10 días. [1]\n", CITES)
    runs = doc.lead
    assert [r.cite for r in runs] == [None, 1, None]
    assert runs[0].text.endswith("días\u00a0") and runs[2].text == "."


def test_chat_message_counts_what_the_card_shows():
    deck = DocumentRequest("pptx", "presentation", "viáticos", explicit=False)
    msg = chat_message("Viáticos", deck, 7, 1, "Hazme una presentación sobre viáticos")
    assert "con 7 diapositivas, a partir de uno de tus documentos." in msg
    rep = DocumentRequest("pdf", "report", "travel", explicit=True)
    assert "4 sections" in chat_message("Travel", rep, 4, 2, "Make a report on travel") and "2 of your documents" in \
        chat_message("Travel", rep, 4, 2, "Make a report on travel")


def test_pptx_footer_groups_passages_of_the_same_document():
    cites = [{**CITES[0], "n": n, "section": f"S{n}"} for n in (1, 2)]
    data = render("# T\n\n## Uno\n\n- Primero [1].\n- Segundo [2].\n", "pptx", cites, kind="presentation").data
    texts = [sh.text_frame.text for sh in Presentation(io.BytesIO(data)).slides[1].shapes if sh.has_text_frame]
    assert any(t.startswith("Fuentes: [1][2] Política de Teletrabajo, p. 4") or
               t.startswith("Sources: [1][2] Política de Teletrabajo, p. 4") for t in texts)


XLSX_MD = """# Tarifas de viaje

Tarifas vigentes para viajes nacionales [1].

## Montos

| Concepto | Valor | Ajuste | Código |
|---|---|---|---|
| Auxilio de conectividad | $120.000 | 12,5 % | 007 |
| =HYPERLINK("http://x") | 45 | -3 % | @SUM(A1) |

## Plazos

| Trámite | Días |
|---|---|
| Legalización [2] | 10 [2] |
"""


def test_xlsx_workbook():
    from openpyxl import load_workbook
    out = render(XLSX_MD, "xlsx", CITES, kind="table")
    assert out.mime == "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    assert out.filename == "tarifas-de-viaje.xlsx"
    wb = load_workbook(io.BytesIO(out.data))
    # Only a lead besides the tables: no Content sheet, the lead sits under the first table's title.
    assert wb.sheetnames == ["Montos", "Plazos", "Fuentes"]
    ws = wb["Montos"]
    assert ws["A1"].value == "Montos" and ws["A1"].font.b
    assert ws["A2"].value == "Tarifas vigentes para viajes nacionales."
    assert ws.freeze_panes == "A5" and ws.print_title_rows == "$4:$4"
    assert [c.value for c in ws[4]] == ["Concepto", "Valor", "Ajuste", "Código", "Fuente"]
    table = ws.tables["Ragis1"]
    assert table.ref == "A4:E6"
    # Spanish numbers become real numbers with a format; codes stay text.
    assert ws["B5"].value == 120000 and ws["B5"].number_format == '"$"#,##0'
    assert ws["C5"].value == 0.125 and ws["C5"].number_format == "0.0%"
    assert ws["D5"].value == "007" and ws["D5"].data_type == "s"
    # Formula-looking text is stored as text, never as a formula.
    assert ws["A6"].value.startswith("=HYPERLINK") and ws["A6"].data_type == "s"
    assert ws["D6"].value == "@SUM(A1)" and ws["D6"].data_type == "s"
    assert ws["B6"].value == 45 and ws["C6"].value == -0.03
    plazos = wb["Plazos"]
    assert [c.value for c in plazos[5]] == ["Legalización", 10, "Procedimiento TH-07, p. 2"]
    src = wb["Fuentes"]
    assert [c.value for c in src[4]] == ["#", "Documento", "Versión", "Página", "Sección", "Vigente desde"]
    assert src["A5"].value == "[1]" and src["B5"].value == "Política de Teletrabajo"
    assert any("Generado con IA" in str(c.value) for row in src.iter_rows() for c in row if c.value)
    assert wb.properties.creator == "Ragis" and wb.properties.title == "Tarifas de viaje"


def test_xlsx_mixed_document_and_long_sheet_names():
    from openpyxl import load_workbook
    wb = load_workbook(io.BytesIO(render(MD, "xlsx", CITES).data))
    assert wb.sheetnames == ["Condiciones", "Contenido", "Fuentes"]
    content = wb["Contenido"]
    assert content["A5"].value == "Resumen" and content["C5"].value.startswith("Política de Teletrabajo, p. 4")
    long = "# T\n\n## Tabla de montos de viáticos, hospedaje y anticipos\n\n| A | B |\n|---|---|\n| x | y [1] |\n"
    assert load_workbook(io.BytesIO(render(long, "xlsx", CITES).data)).sheetnames[0] == "Tabla de montos de viáticos"


def test_xlsx_without_tables_is_one_content_sheet():
    from openpyxl import load_workbook
    wb = load_workbook(io.BytesIO(render("# T\n\n## Alcance\n\n- Aplica a todos [1].\n", "xlsx", CITES).data))
    assert wb.sheetnames[0] == "Content" and wb["Content"]["B5"].value == "Aplica a todos."


@pytest.mark.parametrize("text,lang,expected", [
    ("$120.000", "es", (120000, '"$"#,##0')),
    ("1.234,5", "es", (1234.5, "#,##0.0")),
    ("1,234.5", "en", (1234.5, "#,##0.0")),
    ("1.234", "en", (1.234, "0.000")),
    ("12 %", "es", (0.12, "0%")),
    ("2026", "es", (2026, "0")),
    ("-5", "en", (-5, "0")),
    ("007", "es", None),
    ("9001234567890123", "en", None),
    ("180000 pesos", "es", None),
    ("v3", "en", None),
])
def test_xlsx_numbers_follow_the_document_language(text, lang, expected):
    assert number(text, lang) == expected


def test_markdown_export_appends_sources():
    text = render(MD, "md", CITES).data.decode()
    assert text.startswith("# Política de teletrabajo") and "## Fuentes" in text and "[3] Anexo de teletrabajo" in text


def test_renderers_never_fetch_remote_content():
    md = "# T\n\nTexto con imagen ![logo](http://169.254.169.254/latest/meta-data) y [enlace](javascript:alert(1)) [1].\n"
    for fmt in ("pdf", "docx", "pptx"):
        data = render(md, fmt, CITES).data
        assert b"169.254.169.254" not in data and b"javascript:" not in data


# ---------------------------------------------------------------------------------------------------- flujo con BD

POLICY = """# Política de teletrabajo

## Alcance
El teletrabajo aplica al personal con contrato indefinido y más de seis meses de antigüedad en la empresa.

## Días permitidos
Se permiten hasta tres días de teletrabajo por semana, acordados con el jefe directo.

## Auxilio
La empresa reconoce un auxilio de conectividad de 120000 pesos mensuales a quien teletrabaje.
"""


def test_document_flow_generates_private_file(make_tenant, s3, worker_pool, app_pool, owner):
    from ragsis_ingest.pipeline import IngestPipeline
    from ragsis_rag.orchestrator import QueryOptions, QueryOrchestrator

    acme = make_tenant("docs")
    _, _, msg = acme.add_document(s3, "teletrabajo.md", POLICY.encode(), "text/markdown", title="Política de teletrabajo")
    assert IngestPipeline(pool=worker_pool).handle(msg) == "indexed"
    rag = QueryOrchestrator(pool=app_pool)

    res = rag.run(acme.claims(), "Hazme una presentación en PowerPoint sobre la política de teletrabajo",
                  QueryOptions(output="auto"))
    assert not res.abstained and res.question_class == "document" and res.document
    d = res.document
    assert d["format"] == "pptx" and d["kind"] == "presentation" and d["slides"] >= 3 and d["sources"] >= 1
    assert "presentación" in res.answer and d["markdown"].startswith("# Presentación: ")
    assert res.citations and all(c["document_id"] == str(msg.document_id) for c in res.citations)

    row = owner.execute("SELECT * FROM generated_documents WHERE id=%s", (d["id"],)).fetchone()
    assert row["user_id"] == acme.user and row["query_run_id"] == res.trace_id and row["markdown"] == d["markdown"]
    for fmt in ("pdf", "docx", "pptx", "csv", "md"):
        assert render(row["markdown"], fmt, row["citations"], kind=row["kind"]).data

    # La interfaz pidió un formato: se respeta aunque la pregunta no lo diga.
    forced = rag.run(acme.claims(), "¿Cuántos días de teletrabajo se permiten?", QueryOptions(output="docx"))
    assert forced.document and forced.document["format"] == "docx"
    # Contrato anterior: sin `output` es una respuesta normal aunque el texto pida un archivo.
    plain_answer = rag.run(acme.claims(), "Hazme un PDF sobre la política de teletrabajo")
    assert plain_answer.document is None
    # Sin evidencia: no hay archivo.
    none = rag.run(acme.claims(), "Crea un informe en PDF sobre la flota de aviones", QueryOptions(output="auto"))
    assert none.abstained and none.document is None
    # Privado: otra persona de la misma organización y del mismo workspace no lo ve (RLS), aunque vea las fuentes.
    import uuid

    from ragsis_core.db import fetch_all, tenant_tx
    bob = uuid.uuid4()
    owner.execute("INSERT INTO users (id, identity_provider, external_subject, email) VALUES (%s,'test',%s,%s)",
                  (bob, str(bob), f"bob-{bob.hex[:6]}@example.test"))
    owner.execute("INSERT INTO memberships (organization_id, user_id, role) VALUES (%s,%s,'admin')", (acme.org, bob))
    bob_claims = acme.claims(user=bob, principals=(f"user:{bob}", f"workspace:{acme.ws}"))
    with tenant_tx(bob_claims.security_context(), app_pool) as conn:
        assert fetch_all(conn, "SELECT id FROM generated_documents") == []
    with tenant_tx(acme.claims().security_context(), app_pool) as conn:
        assert len(fetch_all(conn, "SELECT id FROM generated_documents")) == 2
