"""A lived-in week for the judicial demo (make seed-judicial-week): the firm looks like it has used Ragis for ten days.

Runs on top of `make seed-judicial` (it needs the «Ortiz Lozano Abogados» organization, its documents, agents and
workflows). Everything goes through the public API, as the people of the firm would do it, and each action is then
dated back to its day and hour in Postgres, so lists, histories and the audit log read like real use:

  - People: five more members (a second partner, an associate, billing, a paralegal and an assistant), with names
    taken from the case files, display names, functional roles and space access.
  - Teams: «Litigio constitucional», «Investigación jurídica» and «Administración y facturación», each with its space,
    lead and members; requests between them with assignments, comments, waiting/done states and due dates.
  - Library: folders for the case file, eight new documents (DOCX, XLSX, PDF, TXT, Markdown) uploaded on the day they
    belong to, and a second version of the hours sheet.
  - Ask: about eighteen conversations across five people, some with follow-ups and some that produce a PDF, Word,
    PowerPoint or Excel file.
  - Workflows: runs started and decided across the week (approved, rejected) and three that still wait today.
  - Signatures: saved signatures, a partners' minute signed by both partners, and a power of attorney that waits for
    the client's signature.
  - Agents and settings: version 1.1.0 of the case searcher, public records turned on (Colombia), and the client's
    email domain allowed for external signers.

The first run replaces the runs left by `make seed-judicial` (they are recreated on their days) and moves the setup
of the organization to the first day. Conversations people typed by hand are never touched. The audit chain is
recomputed at the end, so it still verifies.

Dates are relative to the day it runs: day 0 is today (morning only), day 10 is the first day. Don't use the
organization in the app while it runs (about 20 minutes with a local model): anything done meanwhile would be dated
into the story. Safe to run again: finished steps are skipped (it resumes after a failure).

    uv run python scripts/seed-judicial-week.py [--api http://localhost:4000] [--pg-container ragsis-postgres-1]
"""

from __future__ import annotations

import argparse
import base64
import io
import subprocess
import sys
import time
import uuid
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

import httpx
from ragsis_eval.run import CONTENT_TYPES, Session, login

TZ = ZoneInfo("America/Bogota")
ORG_NAME = "Ortiz Lozano Abogados"
NS = uuid.UUID("6f7d2b8e-4c1a-4f59-9a51-0c3f7e1d2a90")  # deterministic ids (conversations, signature keys)
TERMINAL = {"COMPLETED", "FAILED", "CANCELLED"}
MONTHS = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre",
          "noviembre", "diciembre"]

# key -> (email, display name, org role, functional roles). The first two come from `make seed-judicial`; their roles
# stay as that script sets them so running it again changes nothing.
PEOPLE = {
    "mariana": ("socia@ortizlozano.test", "Mariana Ortiz Lozano", "owner",
                ["reviewer", "approver", "signatory", "agent_designer", "knowledge_manager"]),
    "tomas": ("asociado@ortizlozano.test", "Tomás Rengifo Bernal", "member", ["reviewer"]),
    "ricardo": ("ricardo@ortizlozano.test", "Ricardo Lozano Pérez", "admin", ["approver", "signatory", "auditor"]),
    "laura": ("laura@ortizlozano.test", "Laura Méndez Quintero", "member", ["reviewer"]),
    "andres": ("andres@ortizlozano.test", "Andrés Felipe Quintana", "member", []),
    "camilo": ("camilo@ortizlozano.test", "Camilo Herrera Duque", "member", []),
    "daniela": ("daniela@ortizlozano.test", "Daniela Suárez Pinto", "member", []),
}
NEW_PEOPLE = ["ricardo", "laura", "andres", "camilo", "daniela"]
CLIENT = {"name": "Juan Felipe Parra Rosas", "email": "juanfelipe.parra@parrarosas.test"}
CLIENT_DOMAIN = "parrarosas.test"

# key -> (name, description, color, lead, {member: access})
TEAMS = {
    "litigio": ("Litigio constitucional", "Demandas de inconstitucionalidad, escritos y relación con el cliente.",
                "violet", "mariana", {"tomas": "editor", "camilo": "editor"}),
    "investigacion": ("Investigación jurídica", "Seguimiento de expedientes en la Corte, jurisprudencia y memos.",
                      "teal", "laura", {"camilo": "editor"}),
    "admin": ("Administración y facturación", "Horas, cuentas de cobro, agenda y archivo.", "amber", "andres",
              {"daniela": "editor"}),
}
# Folders in the firm's main space and which existing documents go in each one.
FOLDERS = {
    "Expediente D-16.857": ["Sentencia C-217 de 2026", "Escrito de corrección de la demanda", "Cronología del expediente",
                            "Estrategia después del fallo"],
    "Cliente — Juan Felipe Parra Rosas": ["Acta de reunión con el cliente"],
    "Jurisprudencia": ["Boletín de jurisprudencia laboral"],
    "Socios": ["Memorando confidencial de honorarios"],
}


def day(n: int) -> date:
    """The calendar day `n` days before today (Bogotá)."""
    return datetime.now(TZ).date() - timedelta(days=n)


def es_date(d: date) -> str:
    return f"{d.day} de {MONTHS[d.month - 1]} de {d.year}"


# ---------------------------------------------------------------------------------------------------- documents
# Fictional firm files that continue the corpus of eval/corpus/judicial (same people, dates and figures).

def _docx(title: str, blocks: list[tuple[str, str]]) -> bytes:
    from docx import Document
    from docx.shared import Pt

    d = Document()
    d.styles["Normal"].font.size = Pt(11)
    d.add_heading(title, level=1)
    for kind, text in blocks:
        if kind == "h":
            d.add_heading(text, level=2)
        elif kind == "li":
            d.add_paragraph(text, style="List Bullet")
        else:
            d.add_paragraph(text)
    buf = io.BytesIO()
    d.save(buf)
    return buf.getvalue()


def _xlsx(sheets: dict[str, list[tuple]]) -> bytes:
    from openpyxl import Workbook
    from openpyxl.styles import Font

    wb = Workbook()
    wb.remove(wb.active)
    for name, rows in sheets.items():
        ws = wb.create_sheet(name)
        for r in rows:
            ws.append(r)
        for c in ws[1]:
            c.font = Font(bold=True)
        for col in ws.columns:
            ws.column_dimensions[col[0].column_letter].width = min(60, max(12, *(len(str(c.value or "")) for c in col)))
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def _pdf(title: str, paragraphs: list[str], signatures: list[str]) -> bytes:
    from reportlab.lib.pagesizes import LETTER
    from reportlab.lib.styles import getSampleStyleSheet
    from reportlab.lib.units import cm
    from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer

    buf = io.BytesIO()
    styles = getSampleStyleSheet()
    body = styles["BodyText"]
    body.fontSize, body.leading = 11, 16
    story = [Paragraph(title, styles["Title"]), Spacer(1, 0.4 * cm)]
    for p in paragraphs:
        story += [Paragraph(p, body), Spacer(1, 0.25 * cm)]
    story.append(Spacer(1, 1.2 * cm))
    for s in signatures:
        story += [Paragraph("_______________________________", body), Paragraph(s, body), Spacer(1, 0.9 * cm)]
    SimpleDocTemplate(buf, pagesize=LETTER, leftMargin=2.5 * cm, rightMargin=2.5 * cm, topMargin=2.2 * cm,
                      title=title, author="Ortiz Lozano Abogados S.A.S.").build(story)
    return buf.getvalue()


def doc_informe_trimestral() -> bytes:
    return _docx("Informe trimestral al cliente N.º 1 — expediente D-16.857", [
        ("p", "Para: Juan Felipe Parra Rosas. De: Tomás Rengifo Bernal, asociado. Revisó: Mariana Ortiz Lozano, socia."),
        ("p", "Fecha de envío: 30 de octubre de 2026, como se acordó en la reunión del 28 de julio de 2026."),
        ("h", "1. Lo que decidió la Corte"),
        ("p", "En la Sentencia C-217 de 2026, del 23 de julio de 2026, la Corte Constitucional se inhibió: no resolvió "
              "si el parágrafo del artículo 1º de la Ley 1010 de 2006 es constitucional, porque el Convenio 190 de la "
              "OIT todavía no ha sido ratificado y por eso no sirve como parámetro de control. La decisión no hace "
              "tránsito a cosa juzgada, de modo que se puede volver a demandar."),
        ("h", "2. Estado del control automático (expediente LAT-506)"),
        ("p", "La Corte revisa la Ley 2528 de 2025, que aprobó el Convenio 190. Al cierre de este informe el "
              "expediente está en etapa de intervenciones y el concepto de la Procuraduría General de la Nación sigue "
              "pendiente."),
        ("h", "3. Próximos pasos"),
        ("li", "Laura Méndez Quintero revisa cada mes el expediente LAT-506."),
        ("li", "Mariana Ortiz Lozano prepara el borrador de la nueva demanda antes del 31 de enero de 2027."),
        ("li", "Reunión de seguimiento con el cliente: 12 de noviembre de 2026."),
        ("li", "Próximo informe trimestral: finales de enero de 2027."),
    ])


def doc_seguimiento_lat506(d: date) -> bytes:
    return _docx("Seguimiento del expediente LAT-506 — noviembre de 2026", [
        ("p", f"Memo interno de Investigación jurídica. Elaboró: Laura Méndez Quintero. Fecha: {es_date(d)}."),
        ("h", "Qué es el expediente"),
        ("p", "Revisión automática de constitucionalidad de la Ley 2528 de 2025, aprobatoria del Convenio 190 de la "
              "OIT sobre la eliminación de la violencia y el acoso en el mundo del trabajo."),
        ("h", "Estado actual"),
        ("li", f"La Procuraduría General de la Nación rindió concepto el {es_date(d - timedelta(days=1))} y pidió "
               "declarar exequibles la ley y el convenio."),
        ("li", "Se recibieron nueve intervenciones: siete piden la exequibilidad y dos la exequibilidad condicionada."),
        ("li", "El expediente pasó al despacho para elaborar la ponencia. Fallo estimado: primer trimestre de 2027."),
        ("h", "Qué significa para el caso Parra Rosas"),
        ("p", "Si la ley se declara exequible, el Gobierno puede ratificar el convenio y depositar el instrumento ante "
              "la OIT. Solo después la nueva demanda tendría un parámetro de control vigente, que fue lo que faltó en "
              "la Sentencia C-217 de 2026. La radicación seguiría el escenario principal del comité de litigio (55 %): "
              "nueva demanda en el primer trimestre de 2028."),
        ("h", "Siguiente revisión"),
        ("p", "Primera semana de diciembre de 2026. Responsable: Laura Méndez Quintero."),
    ])


def doc_horas(second_version: bool) -> bytes:
    tomas = [("2026-10-06", "Tomás Rengifo Bernal", "Revisión de la cronología del expediente", 3.0),
             ("2026-10-14", "Tomás Rengifo Bernal", "Preparación del informe trimestral", 4.5),
             ("2026-10-28", "Tomás Rengifo Bernal", "Ajustes finales del informe trimestral", 4.5)]
    if second_version:
        tomas.insert(2, ("2026-10-20", "Tomás Rengifo Bernal", "Redacción del informe trimestral (20 al 24 de octubre)", 9.0))
    rows = [
        ("Fecha", "Abogado", "Actividad", "Horas", "Caso"),
        ("2026-10-02", "Mariana Ortiz Lozano", "Comité interno sobre la estrategia después del fallo", 2.0, "Parra Rosas"),
        ("2026-10-15", "Mariana Ortiz Lozano", "Revisión del informe trimestral", 1.5, "Parra Rosas"),
        ("2026-10-29", "Mariana Ortiz Lozano", "Aprobación y envío del informe trimestral", 3.0, "Parra Rosas"),
        *[(f, a, act, h, "Parra Rosas") for f, a, act, h in tomas],
        ("2026-10-09", "Laura Méndez Quintero", "Revisión mensual del expediente LAT-506", 3.5, "Parra Rosas"),
        ("2026-10-23", "Laura Méndez Quintero", "Búsqueda de intervenciones en el expediente LAT-506", 4.5, "Parra Rosas"),
        ("2026-10-21", "Camilo Herrera Duque", "Fichas de las intervenciones de la Sentencia C-217 de 2026", 5.5, "Parra Rosas"),
    ]
    totals = {}
    for r in rows[1:]:
        totals[r[1]] = totals.get(r[1], 0) + r[3]
    rates = {"Mariana Ortiz Lozano": 450000, "Tomás Rengifo Bernal": 210000, "Laura Méndez Quintero": 210000,
             "Camilo Herrera Duque": 90000}
    summary = [("Abogado", "Horas de octubre", "Tarifa por hora (COP)", "Valor (COP)")]
    summary += [(a, h, rates[a], int(h * rates[a])) for a, h in totals.items()]
    if not second_version:
        summary.append(("Pendiente", "Tomás Rengifo Bernal no ha registrado las horas del 20 al 24 de octubre.", "", ""))
    return _xlsx({"Octubre": rows, "Resumen": summary})


def doc_matriz_riesgos() -> bytes:
    return _xlsx({"Riesgos": [
        ("Riesgo", "Probabilidad", "Impacto", "Mitigación", "Responsable"),
        ("El Convenio 190 de la OIT aún no está ratificado al radicar", "Alta", "Alto",
         "No radicar hasta el depósito del instrumento ante la OIT (lección de la Sentencia C-217 de 2026)",
         "Mariana Ortiz Lozano"),
        ("Demora del expediente LAT-506 mayor a 18 meses", "Media", "Medio",
         "Acción de tutela en casos concretos de contratistas", "Mariana Ortiz Lozano"),
        ("Derogatoria tácita por el artículo 18 de la Ley 2466 de 2025", "Media", "Alto",
         "Preparar un argumento subsidiario en el memo de investigación", "Laura Méndez Quintero"),
        ("Cosa juzgada por la Sentencia C-960 de 2007", "Baja", "Alto",
         "El cargo usa un parámetro distinto: artículo 2 del Convenio 190", "Tomás Rengifo Bernal"),
        ("Inexequibilidad de la Ley 2528 de 2025", "Baja", "Alto", "Archivar el caso y cerrar la fase 2",
         "Mariana Ortiz Lozano"),
    ]})


def doc_checklist() -> bytes:
    return """# Lista de verificación — nueva demanda contra el parágrafo del artículo 1º de la Ley 1010 de 2006

Responsable: Mariana Ortiz Lozano. Equipo: Litigio constitucional.

## Antes de redactar

- [x] Leer otra vez la Sentencia C-217 de 2026 y anotar por qué la Corte se inhibió.
- [x] Confirmar con el cliente que autoriza la nueva demanda (reunión del 28 de julio de 2026).
- [ ] Recibir el memo mensual de Laura Méndez Quintero sobre el expediente LAT-506.

## Condición para radicar

- [ ] La Corte declara exequible la Ley 2528 de 2025.
- [ ] El Gobierno ratifica el Convenio 190 y deposita el instrumento ante la OIT.

## Borrador

- [ ] Cargo único: violación del artículo 2 del Convenio 190 de la OIT.
- [ ] Explicar por qué no hay cosa juzgada frente a la Sentencia C-960 de 2007.
- [ ] Argumento subsidiario sobre la derogatoria tácita por la Ley 2466 de 2025.
- [ ] Borrador listo antes del 31 de enero de 2027.

## Firma y radicación

- [ ] Poder especial firmado por el cliente.
- [ ] Revisión del escrito en Ragis con el flujo «Revisión de escritos del caso».
""".encode()


def doc_acta_socios(d: date) -> bytes:
    return _pdf("Acta de socios N.º 11 — presupuesto de la fase 2 del caso Parra Rosas", [
        f"En Bogotá, el {es_date(d)}, se reunieron los socios de Ortiz Lozano Abogados S.A.S., Mariana Ortiz Lozano "
        "y Ricardo Lozano Pérez, en la oficina de la calle 93 # 11-26.",
        "<b>1. Presupuesto de la fase 2.</b> Se aprueba un presupuesto de 27.500.000 pesos para la nueva demanda del "
        "caso Parra Rosas, condicionado a que el Convenio 190 de la OIT sea ratificado.",
        "<b>2. Facturación.</b> Andrés Felipe Quintana será el responsable de facturación de la fase 2. No se emitirá "
        "ninguna cuenta de cobro de la fase 2 mientras no se cumpla la condición del punto anterior.",
        "<b>3. Riesgo comercial.</b> Si la Corte declara inexequible la Ley 2528 de 2025 en el expediente LAT-506, la "
        "fase 2 se cancela y no habrá honorarios adicionales.",
        "Esta acta es de uso exclusivo de los socios.",
    ], ["Mariana Ortiz Lozano — Socia", "Ricardo Lozano Pérez — Socio"])


def doc_poder(d: date) -> bytes:
    return _pdf("Poder especial", [
        "Señores Magistrados de la Corte Constitucional. E. S. D.",
        "Juan Felipe Parra Rosas, mayor de edad, identificado con cédula de ciudadanía 1.020.734.581, confiere poder "
        "especial, amplio y suficiente a Mariana Ortiz Lozano, abogada con tarjeta profesional 287.415 del C. S. de "
        "la J., socia de Ortiz Lozano Abogados S.A.S., para que presente en su nombre una nueva demanda de "
        "inconstitucionalidad contra el parágrafo del artículo 1º de la Ley 1010 de 2006.",
        "La apoderada queda facultada para radicar la demanda, corregirla, desistir de ella, presentar escritos y "
        "recibir notificaciones. La demanda solo se radicará cuando el Convenio 190 de la OIT haya sido ratificado, "
        "como se acordó en la reunión del 28 de julio de 2026.",
        f"Bogotá, {es_date(d)}.",
    ], ["Juan Felipe Parra Rosas — C. C. 1.020.734.581 (poderdante)",
        "Acepto: Mariana Ortiz Lozano — T. P. 287.415 del C. S. de la J. (apoderada)"])


def doc_acta_cliente(d: date) -> bytes:
    return f"""ACTA DE REUNIÓN CON EL CLIENTE
Ortiz Lozano Abogados S.A.S.

Fecha: {es_date(d)}, 10:00 a. m.
Lugar: sala de juntas, oficina de Bogotá (calle 93 # 11-26)
Asistentes: Juan Felipe Parra Rosas (cliente), Mariana Ortiz Lozano (socia), Tomás Rengifo Bernal (asociado),
Laura Méndez Quintero (asociada).

1. Informe trimestral
El cliente confirmó que recibió el informe trimestral N.º 1, enviado el 30 de octubre de 2026, y no tiene preguntas.

2. Estado del expediente LAT-506
Laura Méndez Quintero explicó que la Procuraduría pidió declarar exequibles la Ley 2528 de 2025 y el Convenio 190,
y que el fallo se espera en el primer trimestre de 2027.

3. Poder especial
El poder especial para la nueva demanda se envió para firma electrónica el {es_date(d - timedelta(days=1))}. La socia
ya lo firmó; falta la firma del cliente, que lo hará esta semana.

4. Decisiones
- Se mantiene la estrategia: esperar el fallo del expediente LAT-506 antes de radicar la nueva demanda.
- La nueva demanda tendrá un solo cargo: violación del artículo 2 del Convenio 190 de la OIT.
- El cliente prefiere recibir los informes por correo y una llamada corta al mes.

5. Compromisos
- Tomás Rengifo Bernal enviará el segundo informe trimestral el 29 de enero de 2027.
- Mariana Ortiz Lozano mantiene el borrador de la nueva demanda para el 31 de enero de 2027.
- Andrés Felipe Quintana enviará la cuenta de cobro de noviembre antes del 20 de noviembre de 2026.

Próxima reunión: 11 de febrero de 2027.
""".encode()


# ---------------------------------------------------------------------------------------------------- Postgres

class Pg:
    """psql inside the Postgres container (superuser): dating actions back and recomputing the audit chain."""

    def __init__(self, container: str):
        self.container = container

    def run(self, sql: str) -> list[list[str]]:
        argv = ["docker", "exec", "-i", self.container, "sh", "-c",
                'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -X -q -At -F "\t"']
        p = subprocess.run(  # noqa: S603 - fixed argv against the local dev container
            argv,  # noqa: S607
            input=sql, text=True, capture_output=True,
        )
        if p.returncode:
            raise RuntimeError(f"psql failed: {p.stderr.strip()[:600]}")
        return [line.split("\t") for line in p.stdout.splitlines() if line.strip()]

    def one(self, sql: str) -> str:
        rows = self.run(sql)
        return rows[0][0] if rows and rows[0] else ""


# Deadlines keep their real value: a human step dated a week back would otherwise expire before its decision.
KEEP = {"expires_at"}
ANCHORS = ("created_at", "started_at", "published_at", "occurred_at", "signed_at", "sent_at", "received_at",
           "updated_at", "last_seen_at")


class Clock:
    """Moves every timestamp an action wrote (inserted or updated rows) to the moment it belongs to in the story."""

    def __init__(self, pg: Pg, org: str):
        self.pg, self.org = pg, org
        members = f"(SELECT user_id FROM memberships WHERE organization_id = '{org}')"
        rows = pg.run("""
            SELECT c.table_name, c.column_name FROM information_schema.columns c
              JOIN information_schema.tables t USING (table_schema, table_name)
             WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE'
               AND c.data_type = 'timestamp with time zone'
               AND (c.table_name IN ('users', 'organizations', 'personal_signatures')
                    OR EXISTS (SELECT 1 FROM information_schema.columns o WHERE o.table_schema = 'public'
                               AND o.table_name = c.table_name AND o.column_name = 'organization_id'))
             ORDER BY c.table_name, c.ordinal_position""")
        self.tables: dict[str, list[str]] = {}
        for table, column in rows:
            self.tables.setdefault(table, []).append(column)
        self.scope = {t: f"organization_id = '{org}'" for t in self.tables}
        self.scope.update(users=f"id IN {members}", organizations=f"id = '{org}'",
                          personal_signatures=f"user_id IN {members}")
        self.last: datetime | None = None

    def now(self) -> str:
        return self.pg.one("SELECT clock_timestamp()")

    def stamp(self, mark: str, target: datetime) -> None:
        time.sleep(1.5)  # let async writers (usage, outbox, runner) finish
        m, d = f"'{mark}'::timestamptz", f"('{target.isoformat()}'::timestamptz - '{mark}'::timestamptz)"
        sql = ["BEGIN;", "SET LOCAL session_replication_role = replica;"]
        for table, all_cols in self.tables.items():
            cols = [c for c in all_cols if c not in KEEP]
            if not cols:
                continue
            anchor = next((a for a in ANCHORS if a in cols), cols[0])
            sets = ", ".join(f"{c} = CASE WHEN {c} >= {m} AND ({anchor} >= {m} OR {c} <= now()) THEN {c} + {d} ELSE {c} END"
                             for c in cols)
            hit = " OR ".join(f"{c} >= {m}" for c in cols)
            sql.append(f"UPDATE {table} SET {sets} WHERE {self.scope[table]} AND ({hit});")
        sql.append("COMMIT;")
        self.pg.run("\n".join(sql))
        self.last = target

    def compress_existing(self, t0: datetime, t1: datetime, end: str) -> None:
        """Squeezes everything that already exists (setup by seed-judicial, earlier tests) into [t0, t1]."""
        m0 = self.pg.one(f"SELECT created_at FROM organizations WHERE id = '{self.org}'")
        span = float(self.pg.one(f"SELECT extract(epoch FROM '{end}'::timestamptz - '{m0}'::timestamptz)"))
        f = max(60.0, (t1 - t0).total_seconds()) / max(span, 1.0)
        T0, M0, E = f"'{t0.isoformat()}'::timestamptz", f"'{m0}'::timestamptz", f"'{end}'::timestamptz"
        sql = ["BEGIN;", "SET LOCAL session_replication_role = replica;"]
        for table, cols in self.tables.items():
            if table in ("conversations", "conversation_turns"):  # what people typed in Ask keeps its real date
                continue
            sets = ", ".join(
                f"{c} = CASE WHEN {c} IS NULL THEN NULL WHEN {c} <= {E} THEN {T0} + ({c} - {M0}) * {f} "
                f"ELSE {T0} + ({E} - {M0}) * {f} + ({c} - {E}) END" for c in cols)
            sql.append(f"UPDATE {table} SET {sets} WHERE {self.scope[table]};")
        sql.append("COMMIT;")
        self.pg.run("\n".join(sql))

    def sweep(self, since: str) -> None:
        """Late async writes (indexing, graph, usage) that landed after their action was dated: put them at the end."""
        if not self.last:
            return
        self.stamp(since, self.last + timedelta(minutes=2))

    def rechain_audit(self) -> None:
        """Audit ids follow the story's order again and every hash is recomputed (same formula as app.audit_chain)."""
        o = self.org
        self.pg.run(f"""
BEGIN;
SET LOCAL session_replication_role = replica;
CREATE TEMP TABLE ord ON COMMIT DROP AS
  SELECT id AS old_id, row_number() OVER (ORDER BY created_at, id) AS rn FROM audit_events WHERE organization_id = '{o}';
CREATE TEMP TABLE ids ON COMMIT DROP AS
  SELECT id AS new_id, row_number() OVER (ORDER BY id) AS rn FROM audit_events WHERE organization_id = '{o}';
UPDATE audit_events SET id = -id WHERE organization_id = '{o}';
UPDATE audit_events a SET id = i.new_id FROM ord JOIN ids i USING (rn)
 WHERE a.organization_id = '{o}' AND a.id = -ord.old_id;
DO $$
DECLARE r record; prev text := NULL; h text;
BEGIN
  FOR r IN SELECT * FROM audit_events WHERE organization_id = '{o}' ORDER BY id LOOP
    h := encode(sha256(convert_to(
      coalesce(prev, '') || '|' || r.organization_id::text || '|' || coalesce(r.actor_id::text, '') || '|' ||
      r.action || '|' || r.resource || '|' || r.decision || '|' || r.metadata::text || '|' ||
      to_char(r.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US'), 'UTF8')), 'hex');
    UPDATE audit_events SET prev_hash = prev, hash = h WHERE id = r.id;
    prev := h;
  END LOOP;
END $$;
COMMIT;""")


# ---------------------------------------------------------------------------------------------------- the firm

@dataclass
class Firm:
    api: str
    org: str
    general: str
    s: dict[str, Session] = field(default_factory=dict)
    uid: dict[str, str] = field(default_factory=dict)
    teams: dict[str, dict] = field(default_factory=dict)       # key -> {"id", "workspace_id"}
    folders: dict[str, str] = field(default_factory=dict)      # name -> id (main space)
    docs: dict[str, dict] = field(default_factory=dict)        # title -> {"id", "version_id", "workspace_id"}
    workflows: dict[str, str] = field(default_factory=dict)    # template -> id
    requests: dict[str, str] = field(default_factory=dict)     # key -> request id (created in this run)
    saved_signature: dict[str, str] = field(default_factory=dict)
    envelopes: dict[str, str] = field(default_factory=dict)
    space_of: dict[str, str] = field(default_factory=dict)     # "general" | team key -> workspace id

    def r(self, who: str, method: str, path: str, **kw):
        return self.s[who].req(method, f"organizations/{self.org}/{path}", **kw)

    def ws(self, key: str) -> str:
        return self.general if key == "general" else self.teams[key]["workspace_id"]


def setup_people(f: Firm) -> None:
    joined = {m["email"] for m in f.r("mariana", "GET", "members").json()["members"]}
    if not all(PEOPLE[k][0] in joined for k in NEW_PEOPLE):
        add_people(f)
    # Laura starts workflows too: like the associate (seed-judicial), she reads every space that isn't a team's, so
    # an agent pointed at one of them doesn't stop on a permission error.
    spaces = [w["id"] for w in f.r("mariana", "GET", "workspaces").json()["workspaces"] if not w.get("team_id")]
    mine = {w["id"] for w in f.r("laura", "GET", "workspaces").json()["workspaces"]}
    for ws in spaces:
        if ws not in mine:
            f.r("mariana", "POST", f"workspaces/{ws}/members", json={"user_id": f.uid["laura"], "role": "reader"})


def add_people(f: Firm) -> None:
    groups = {g["name"]: g["id"] for g in f.r("mariana", "GET", "groups").json()["groups"]}
    for key in NEW_PEOPLE:
        email, _, role, _ = PEOPLE[key]
        f.r("mariana", "POST", "members", json={"email": email, "role": role})
    access = {"tomas": "editor", "ricardo": "editor", "laura": "reader", "camilo": "reader", "andres": "reader"}
    for key, role in access.items():
        f.r("mariana", "POST", f"workspaces/{f.general}/members", json={"user_id": f.uid[key], "role": role})
    if "Socios" in groups:
        f.r("mariana", "POST", f"groups/{groups['Socios']}/members", json={"user_id": f.uid["ricardo"]})
    members = {m["email"]: m for m in f.r("mariana", "GET", "functional-roles").json()["members"]}
    for key in NEW_PEOPLE:
        email, _, _, roles = PEOPLE[key]
        if roles and sorted(members.get(email, {}).get("roles", [])) != sorted(roles):
            f.r("mariana", "PUT", f"members/{members[email]['id']}/functional-roles", json={"roles": roles})
    print(f"  People: {', '.join(PEOPLE[k][1] for k in NEW_PEOPLE)} joined.")


def setup_teams(f: Firm) -> None:
    existing = {t["name"]: t for t in f.r("mariana", "GET", "teams").json()["teams"]}
    for key, (name, desc, color, lead, members) in TEAMS.items():
        if name in existing:
            f.teams[key] = {"id": existing[name]["id"], "workspace_id": existing[name]["workspace_id"]}
            continue
        t = f.r("mariana", "POST", "teams", json={
            "name": name, "description": desc, "color": color, "lead_user_id": f.uid[lead]}).json()
        f.teams[key] = {"id": t["id"], "workspace_id": t["workspace_id"]}
        for m, access in members.items():
            f.r("mariana", "PUT", f"teams/{t['id']}/members/{f.uid[m]}", json={"access": access})
    print(f"  Teams: {', '.join(t[0] for t in TEAMS.values())}.")


def setup_folders(f: Firm) -> None:
    have = {x["name"]: x["id"] for x in f.r("mariana", "GET", "folders", params={"workspace_id": f.general}).json()["folders"]}
    for name, titles in FOLDERS.items():
        fid = have.get(name) or f.r("mariana", "POST", "folders", json={"workspace_id": f.general, "name": name}).json()["id"]
        f.folders[name] = fid
        ids = [f.docs[t]["id"] for t in titles if t in f.docs and f.docs[t].get("folder_id") != fid]
        if ids:
            f.r("mariana", "POST", "documents/move", json={"document_ids": ids, "folder_id": fid})
    print(f"  Library: folders {', '.join(FOLDERS)}.")


# Someone who belongs to each space (a team's space is only listed to its members).
SPACE_READER = {"general": "mariana", "litigio": "mariana", "investigacion": "laura", "admin": "andres"}


def load_docs(f: Firm) -> None:
    f.docs.clear()
    for space, who in SPACE_READER.items():
        ws = f.ws(space)
        for d in f.r(who, "GET", "documents", params={"workspace_id": ws, "limit": 200}).json()["documents"]:
            f.docs[d["title"]] = {"id": d["id"], "workspace_id": ws, "version_id": d.get("current_version_id"),
                                  "folder_id": d.get("folder_id")}


def upload(f: Firm, who: str, space: str, title: str, filename: str, data: bytes, folder: str | None = None,
           acl: list[str] | None = None) -> bool:
    if title in f.docs:
        return False
    ext = Path(filename).suffix.lower()
    body = {"workspace_id": f.ws(space), "filename": filename, "content_type": CONTENT_TYPES[ext],
            "size_bytes": len(data), "title": title}
    if folder:
        body["folder_id"] = f.folders[folder]
    if acl:
        body["acl"] = acl
    up = f.r(who, "POST", "documents/uploads", json=body).json()
    httpx.put(up["upload"]["url"], content=data, headers=up["upload"]["headers"], timeout=60).raise_for_status()
    f.r(who, "POST", f"documents/{up['document_id']}/versions/{up['version_id']}/complete")
    wait_indexed(f, who, up["document_id"], title)
    f.docs[title] = {"id": up["document_id"], "version_id": up["version_id"], "workspace_id": f.ws(space)}
    print(f"    uploaded «{title}» ({PEOPLE[who][1]})")
    return True


def new_version(f: Firm, who: str, title: str, filename: str, data: bytes) -> None:
    doc = f.docs[title]
    st = f.r(who, "GET", f"documents/{doc['id']}/status").json()
    if len(st["versions"]) > 1:
        return
    up = f.r(who, "POST", f"documents/{doc['id']}/versions", json={
        "filename": filename, "content_type": CONTENT_TYPES[Path(filename).suffix.lower()], "size_bytes": len(data)}).json()
    httpx.put(up["upload"]["url"], content=data, headers=up["upload"]["headers"], timeout=60).raise_for_status()
    f.r(who, "POST", f"documents/{doc['id']}/versions/{up['version_id']}/complete")
    wait_indexed(f, who, doc["id"], title)
    doc["version_id"] = up["version_id"]
    print(f"    new version of «{title}» ({PEOPLE[who][1]})")


def wait_indexed(f: Firm, who: str, doc_id: str, title: str, timeout: float = 600) -> None:
    end = time.time() + timeout
    while time.time() < end:
        v = f.r(who, "GET", f"documents/{doc_id}/status").json()["versions"][0]
        if v["status"] == "indexed":
            return
        if v["status"] in ("failed", "rejected"):
            raise RuntimeError(f"indexing failed for «{title}»: {v.get('error_code')}")
        time.sleep(2)
    raise RuntimeError(f"indexing timed out for «{title}»")


def ask(f: Firm, who: str, key: str, space: str, turns: list) -> None:
    """One Ask conversation (saved in History). Turns are questions or (question, file format)."""
    cid = str(uuid.uuid5(NS, f"conversation:{who}:{key}"))
    try:
        f.r(who, "GET", f"conversations/{cid}")
        return
    except RuntimeError:
        pass
    for turn in turns:
        q, out = (turn, None) if isinstance(turn, str) else turn
        body = {"question": q, "conversation_id": cid, **({"output": out} if out else {})}
        res = f.r(who, "POST", f"workspaces/{f.ws(space)}/query", json=body).json()
        state = "abstains" if res.get("abstained") else f"{len(res.get('citations') or [])} citation(s)"
        extra = f", {out} file" if out and res.get("document") else ""
        print(f"    Ask [{PEOPLE[who][1].split()[0]}] {q[:70]} -> {state}{extra}")


def request(f: Firm, key: str, who: str, frm: str, to: str, title: str, body: str, priority="normal",
            due: int | None = None) -> None:
    sent = f.r(who, "GET", "requests", params={"view": "sent", "closed": "all"}).json()
    items = sent.get("requests") or sent.get("items") or []
    if any(x["title"] == title for x in items):
        return
    payload = {"to_team_id": f.teams[to]["id"], "from_team_id": f.teams[frm]["id"], "title": title, "body": body,
               "priority": priority}
    if due is not None:
        payload["due_on"] = day(due).isoformat()
    f.requests[key] = f.r(who, "POST", "requests", json=payload).json()["id"]
    print(f"    Request «{title}» ({PEOPLE[who][1]})")


def req_update(f: Firm, key: str, who: str, comment: str | None = None, **patch) -> None:
    rid = f.requests.get(key)
    if not rid:  # created in an earlier run: its story already happened
        return
    if "assignee" in patch:
        patch["assignee_id"] = f.uid[patch.pop("assignee")]
    if patch:
        f.r(who, "PATCH", f"requests/{rid}", json=patch)
    if comment:
        f.r(who, "POST", f"requests/{rid}/comments", json={"body": comment})


def wait_run(f: Firm, who: str, run: str, timeout: float = 300) -> dict:
    end = time.time() + timeout
    while True:
        r = f.r(who, "GET", f"runs/{run}").json()
        if r["state"] in TERMINAL or r["state"] == "WAITING_HUMAN" or time.time() > end:
            return r
        time.sleep(2)


def start_run(f: Firm, key: str, who: str, template: str, task: str) -> str | None:
    if template not in f.workflows:
        print(f"    (workflow {template} not published; skipped)")
        return None
    s = f.s[who]
    r = httpx.post(f"{f.api}/v1/organizations/{f.org}/workflows/{f.workflows[template]}/runs", json={"task": task},
                   timeout=60, headers={"authorization": f"Bearer {s.token}", "idempotency-key": f"seed-week-{key}"})
    if r.status_code >= 400:
        raise RuntimeError(f"start run {key} -> {r.status_code}: {r.text[:300]}")
    res = r.json()
    run = wait_run(f, who, res["id"])
    print(f"    Run [{run['state']}] {run['workflow_name']} ({PEOPLE[who][1]}){' (existing)' if res.get('replay') else ''}")
    return res["id"]


def decide(f: Firm, starter: str, run_id: str | None, who: str, decision: str, comment: str) -> None:
    if not run_id:
        return
    r = wait_run(f, starter, run_id)
    pending = [a for a in r["approvals"] if a["status"] == "PENDING"]
    if r["state"] != "WAITING_HUMAN" or not pending:
        return
    a = pending[0]
    f.r(who, "POST", f"approvals/{a['id']}/decision",
        json={"decision": decision, "action_hash": a["action_hash"], "comment": comment})
    r = wait_run(f, starter, run_id)
    print(f"    Decision [{decision}] by {PEOPLE[who][1]} -> {r['state']}")


def signature_image(name: str) -> str:
    from PIL import Image, ImageDraw, ImageFont

    img = Image.new("RGBA", (900, 260), (255, 255, 255, 0))
    draw = ImageDraw.Draw(img)
    font = None
    for path in ("/System/Library/Fonts/Supplemental/SnellRoundhand.ttc", "/System/Library/Fonts/Supplemental/Zapfino.ttf",
                 "/System/Library/Fonts/Supplemental/Brush Script.ttf"):
        try:
            font = ImageFont.truetype(path, 96)
            break
        except OSError:
            continue
    draw.text((30, 50), name, fill=(28, 45, 110, 255), font=font or ImageFont.load_default(size=72))
    box = img.getbbox() or (0, 0, 900, 260)
    img = img.crop((max(0, box[0] - 12), max(0, box[1] - 12), min(900, box[2] + 12), min(260, box[3] + 12)))
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return base64.b64encode(buf.getvalue()).decode()


def save_signature(f: Firm, who: str, label: str, shown: str) -> None:
    mine = f.s[who].req("GET", "me/signatures").json()
    items = mine.get("signatures") or mine.get("items") or []
    if items:
        f.saved_signature[who] = items[0]["id"]
        return
    res = f.s[who].req("POST", "me/signatures", json={"label": label, "image": signature_image(shown)}).json()
    f.saved_signature[who] = res["id"]
    print(f"    Saved signature ({PEOPLE[who][1]})")


def envelope(f: Firm, key: str, who: str, subject: str, title: str, signers: list[dict]) -> None:
    doc = f.docs[title]
    idem = str(uuid.uuid5(NS, f"envelope:{key}"))
    r = httpx.post(f"{f.api}/v1/organizations/{f.org}/signatures",
                   json={"subject": subject, "version_ids": [doc["version_id"]], "signers": signers}, timeout=60,
                   headers={"authorization": f"Bearer {f.s[who].token}", "idempotency-key": idem})
    if r.status_code >= 400:
        raise RuntimeError(f"envelope {key} -> {r.status_code}: {r.text[:300]}")
    f.envelopes[key] = r.json()["id"]
    if not r.json().get("replay"):
        print(f"    Signature request «{subject}» ({PEOPLE[who][1]})")


def send_envelope(f: Firm, key: str, who: str) -> None:
    env = f.r(who, "GET", f"signatures/{f.envelopes[key]}").json()
    if env.get("state") != "DRAFT" or not env.get("action_hash"):
        return
    f.r(who, "POST", f"signatures/{f.envelopes[key]}/send", json={"action_hash": env["action_hash"]})
    print(f"    Sent for signature ({PEOPLE[who][1]})")


def sign(f: Firm, key: str, who: str) -> None:
    if not f.r(who, "GET", f"signatures/{f.envelopes[key]}").json().get("awaiting_me"):
        return
    sid = f.saved_signature.get(who)
    body = {"decision": "sign", "typed_name": PEOPLE[who][1], "consent": True,
            **({"appearance": {"type": "saved", "id": sid}} if sid else {})}
    try:
        f.r(who, "POST", f"signatures/{f.envelopes[key]}/respond", json=body)
        print(f"    Signed by {PEOPLE[who][1]}")
    except RuntimeError as e:
        if "409" not in str(e):  # already signed in an earlier run
            raise


def publish_agent_version(f: Firm) -> None:
    agents = {a["template_code"]: a for a in f.r("mariana", "GET", "agents").json()["agents"]}
    a = agents.get("searcher")
    if not a:
        return
    detail = f.r("mariana", "GET", f"agents/{a['id']}").json()
    if (detail.get("active_version") or {}).get("version") != "1.0.0":
        return
    cfg = detail["draft"]
    cfg["purpose"] = ("Responde preguntas sobre el expediente D-16.857 con citas, indica la fecha de cada actuación y "
                      "dice cuándo no encuentra la respuesta.")
    f.r("mariana", "PUT", f"agents/{a['id']}/draft", json={"config": cfg})
    test = f.r("mariana", "POST", f"agents/{a['id']}/test", json={}).json()
    if test["status"] != "passed":
        print("    Agent test failed; 1.1.0 not published.")
        return
    pub = f.r("mariana", "POST", f"agents/{a['id']}/publish", json={
        "bump": "minor", "changelog": "Indica la fecha de cada actuación del expediente en las respuestas."}).json()
    print(f"    Agent «{detail['name']}» published {pub['version']}.")


def settings(f: Firm) -> None:
    now = f.r("ricardo", "GET", "public-sources").json()
    if now.get("enabled") or (now.get("settings") or {}).get("enabled"):
        return
    try:
        f.r("ricardo", "PUT", "public-sources", json={"enabled": True, "country": "co", "web": True, "monthly_limit": 300})
        print("    Public records on (Colombia).")
    except RuntimeError as e:
        print(f"    Public records not turned on: {str(e)[:120]}")


def external_policy(f: Firm) -> None:
    if CLIENT_DOMAIN in f.r("mariana", "GET", "external-policy").json().get("allowed_domains", []):
        return
    f.r("mariana", "PUT", "external-policy", json={"allowed_domains": [CLIENT_DOMAIN], "share_max_days": 7,
                                                   "approval_max_age_hours": 24, "require_mfa_for_signature": False})
    print(f"    External signers allowed from {CLIENT_DOMAIN}.")


# ---------------------------------------------------------------------------------------------------- the story

def story(f: Firm) -> list[tuple[int, str, str, Callable[[], object]]]:
    """(days ago, hh:mm in Bogotá, label, action). Day 10 is the first day; day 0 is this morning."""
    G, L, INV, A = "general", "litigio", "investigacion", "admin"
    cli = "Cliente — Juan Felipe Parra Rosas"
    socios = [f"group:{g['id']}" for g in f.r("mariana", "GET", "groups").json()["groups"] if g["name"] == "Socios"]
    runs: dict[str, str | None] = {}

    def run(key, who, template, task):
        return lambda: runs.__setitem__(key, start_run(f, key, who, template, task))

    return [
        # Day 10: the firm goes live (setup by seed-judicial is moved to this morning).
        (10, "14:10", "team joins", lambda: setup_people(f)),
        (10, "14:40", "teams", lambda: setup_teams(f)),
        (10, "15:20", "folders", lambda: (load_docs(f), setup_folders(f))),
        (10, "16:05", "ask", lambda: ask(f, "mariana", "c217", G, [
            "¿Qué decidió la Corte en la Sentencia C-217 de 2026?",
            "¿Por qué la Corte consideró que el Convenio 190 de la OIT no podía ser parámetro de control?"])),
        (10, "16:45", "ask", lambda: ask(f, "ricardo", "honorarios", G, [
            "¿Cuáles son los honorarios pactados en el caso Parra Rosas y se causó la cuota de éxito?"])),
        (10, "17:10", "settings", lambda: settings(f)),
        # Day 9
        (9, "08:50", "upload", lambda: upload(f, "tomas", G, "Informe trimestral al cliente N.º 1",
                                              "informe-trimestral-1.docx", doc_informe_trimestral(), cli)),
        (9, "09:15", "ask", lambda: ask(f, "laura", "intervinientes", G, [
            "¿Qué intervinientes pidieron que la Corte se inhibiera y con qué argumentos?"])),
        (9, "10:30", "request", lambda: request(f, "lat506", "mariana", L, INV,
            "Estado del expediente LAT-506 para la reunión del 12 de noviembre",
            "Necesito un resumen corto del control automático de la Ley 2528 de 2025: concepto de la Procuraduría, "
            "etapa y fecha probable del fallo. Lo llevo a la reunión con el cliente.", "high", due=3)),
        (9, "11:05", "request", lambda: req_update(f, "lat506", "laura", "Lo reviso hoy y les comparto un memo en "
                                                    "Investigación jurídica.", assignee="laura", status="in_progress")),
        (9, "15:30", "upload", lambda: upload(f, "laura", INV, "Seguimiento del expediente LAT-506 — noviembre 2026",
                                              "seguimiento-lat-506-noviembre.docx", doc_seguimiento_lat506(day(9)))),
        (9, "15:40", "request", lambda: req_update(f, "lat506", "laura",
            "Memo cargado en Investigación jurídica: «Seguimiento del expediente LAT-506 — noviembre 2026». Lo clave: "
            "la Procuraduría pidió la exequibilidad y el fallo se espera en el primer trimestre de 2027.", status="done")),
        (9, "16:10", "ask", lambda: ask(f, "tomas", "informe", G, [
            "¿Cuándo debía enviarse el primer informe trimestral al cliente y quién era el responsable?",
            "¿Qué temas incluye el informe trimestral al cliente N.º 1?"])),
        # Day 8
        (8, "08:55", "upload", lambda: upload(f, "andres", A, "Registro de horas — octubre 2026",
                                              "registro-horas-octubre-2026.xlsx", doc_horas(False))),
        (8, "09:20", "request", lambda: request(f, "horas", "andres", A, L,
            "Registrar horas pendientes de octubre — caso Parra Rosas",
            "Faltan las horas de Tomás del 20 al 24 de octubre (informe trimestral). Las necesito para cerrar el "
            "registro del mes.", due=7)),
        (8, "09:50", "request", lambda: req_update(f, "horas", "mariana", assignee="tomas")),
        (8, "10:00", "run", run("cliente", "tomas", "answer_with_approval",
            "Prepara una respuesta para el cliente: ¿qué decidió la Corte en la Sentencia C-217 de 2026 y qué "
            "significa para el caso Parra Rosas?")),
        (8, "10:20", "request", lambda: req_update(f, "lat506", "mariana", "Gracias, Laura. Lo uso en la presentación.")),
        (8, "11:30", "decision", lambda: decide(f, "tomas", runs.get("cliente"), "mariana", "approve",
            "Bien. Agregar que la decisión no hace tránsito a cosa juzgada y enviar.")),
        (8, "14:30", "ask", lambda: ask(f, "mariana", "informe-pdf", G, [
            ("Prepara un informe para el cliente sobre qué decidió la Corte en la Sentencia C-217 de 2026 y qué "
             "significa para el caso Parra Rosas.", "pdf")])),
        (8, "16:00", "ask", lambda: ask(f, "camilo", "pretensiones", G, [
            "¿Qué pretensiones formula el escrito de corrección de la demanda?",
            "¿De qué cargos desistió el demandante en el escrito de corrección de la demanda?"])),
        (8, "17:10", "request", lambda: req_update(f, "horas", "tomas", "Las cargo mañana temprano.", status="in_progress")),
        # Day 7
        (7, "08:40", "request", lambda: req_update(f, "horas", "tomas", "Listo: 9 horas del 20 al 24 de octubre.",
                                                   status="done")),
        (7, "09:05", "version", lambda: new_version(f, "andres", "Registro de horas — octubre 2026",
                                                    "registro-horas-octubre-2026.xlsx", doc_horas(True))),
        (7, "09:30", "run", run("auditoria", "tomas", "audit_if_evidence",
            "Audita la cronología del expediente: ¿quién es responsable de cada actuación y cuántas horas se han "
            "registrado?")),
        (7, "10:40", "decision", lambda: decide(f, "tomas", runs.get("auditoria"), "mariana", "approve",
                                                "Hallazgos revisados.")),
        (7, "11:00", "upload", lambda: upload(f, "camilo", L, "Matriz de riesgos de la nueva demanda",
                                              "matriz-riesgos-nueva-demanda.xlsx", doc_matriz_riesgos())),
        (7, "15:00", "signature", lambda: save_signature(f, "mariana", "Firma", "Mariana Ortiz L.")),
        (7, "15:30", "ask", lambda: ask(f, "laura", "lat506", INV, [
            "¿En qué estado está el expediente LAT-506 y cuándo se espera el fallo?"])),
        (7, "16:40", "ask", lambda: ask(f, "andres", "horas", A, [
            "¿Cuántas horas registró cada abogado en octubre en el caso Parra Rosas?"])),
        # Day 6 (Saturday in the original week)
        (6, "10:20", "ask", lambda: ask(f, "mariana", "presupuesto", G, [
            "¿Cuál es el presupuesto aprobado para la nueva demanda del caso Parra Rosas?"])),
        # Day 4
        (4, "08:45", "agent", lambda: publish_agent_version(f)),
        (4, "09:30", "run", run("presupuesto", "tomas", "answer_with_approval",
            "¿Cuál es el presupuesto aprobado para la nueva demanda del caso Parra Rosas?")),
        (4, "10:15", "decision", lambda: decide(f, "tomas", runs.get("presupuesto"), "mariana", "reject",
            "No enviar: el presupuesto está en el memorando confidencial de honorarios, solo para socios.")),
        (4, "11:00", "request", lambda: request(f, "reunion", "daniela", A, L,
            "Confirmar asistentes y sala para la reunión del 12 de noviembre",
            "Para reservar la sala y avisar en recepción, ¿quiénes asisten por el despacho?", due=2)),
        (4, "11:30", "request", lambda: req_update(f, "reunion", "mariana", assignee="tomas")),
        (4, "14:00", "ask", lambda: ask(f, "mariana", "presentacion", G, [
            ("Haz una presentación para el cliente con lo que decidió la Corte en la Sentencia C-217 de 2026, el "
             "estado del caso Parra Rosas y los próximos pasos.", "pptx")])),
        (4, "15:10", "request", lambda: req_update(f, "reunion", "tomas", "Asistimos Mariana, Laura y yo. Sala de "
                                                   "juntas, 10:00 a. m. El cliente confirmó por teléfono.", status="done")),
        (4, "15:20", "ask", lambda: ask(f, "camilo", "riesgos", L, [
            "¿Cuáles son los riesgos con probabilidad alta en la matriz de riesgos de la nueva demanda?"])),
        (4, "16:30", "upload", lambda: upload(f, "mariana", L, "Lista de verificación — nueva demanda",
                                              "lista-verificacion-nueva-demanda.md", doc_checklist())),
        (4, "17:05", "signature", lambda: save_signature(f, "ricardo", "Firma", "Ricardo Lozano P.")),
        # Day 3
        (3, "10:00", "run", run("correccion", "tomas", "contract_review",
            "Revisa el escrito de corrección de la demanda frente a lo que decidió la Corte en la Sentencia C-217 de 2026.")),
        (3, "11:00", "run", run("informe-trimestral", "laura", "answer_with_approval",
            "¿Cuándo debe enviarse el primer informe trimestral al cliente y qué debe incluir?")),
        (3, "11:30", "request", lambda: request(f, "cobro", "mariana", L, A,
            "Preparar la cuenta de cobro de noviembre — caso Parra Rosas",
            "Incluir las horas de octubre y la reunión del 12 de noviembre. Enviar al cliente antes del 20 de noviembre.",
            due=-7)),
        (3, "12:00", "decision", lambda: decide(f, "tomas", runs.get("correccion"), "mariana", "approve",
                                                "Aprobado. Mantener la pretensión segunda tal como está.")),
        (3, "13:10", "decision", lambda: decide(f, "laura", runs.get("informe-trimestral"), "ricardo", "approve",
                                                "Correcto, ya se envió el 30 de octubre.")),
        (3, "14:00", "request", lambda: req_update(f, "cobro", "andres", "Daniela prepara el borrador.",
                                                   assignee="daniela", status="in_progress")),
        (3, "15:30", "upload", lambda: upload(f, "mariana", G, "Acta de socios N.º 11 — presupuesto de la fase 2",
                                              "acta-socios-11.pdf", doc_acta_socios(day(3)), "Socios", socios or None)),
        (3, "15:40", "signature", lambda: envelope(f, "acta-socios", "mariana", "Acta de socios N.º 11",
            "Acta de socios N.º 11 — presupuesto de la fase 2",
            [{"name": PEOPLE["mariana"][1], "email": PEOPLE["mariana"][0]},
             {"name": PEOPLE["ricardo"][1], "email": PEOPLE["ricardo"][0]}])),
        (3, "16:05", "signature", lambda: (send_envelope(f, "acta-socios", "ricardo"), sign(f, "acta-socios", "ricardo"))),
        (3, "16:20", "ask", lambda: ask(f, "tomas", "cronologia-xlsx", G, [
            ("Haz una tabla con la cronología del expediente: fecha, actuación y responsable.", "xlsx")])),
        (3, "17:20", "signature", lambda: sign(f, "acta-socios", "mariana")),
        # Day 2
        (2, "09:00", "upload", lambda: upload(f, "tomas", G, "Poder especial — Juan Felipe Parra Rosas",
                                              "poder-especial-parra-rosas.pdf", doc_poder(day(2)), cli)),
        (2, "09:10", "settings", lambda: external_policy(f)),
        (2, "09:20", "signature", lambda: envelope(f, "poder", "tomas", "Poder especial para la nueva demanda",
            "Poder especial — Juan Felipe Parra Rosas",
            [CLIENT, {"name": PEOPLE["mariana"][1], "email": PEOPLE["mariana"][0]}])),
        (2, "10:25", "signature", lambda: (send_envelope(f, "poder", "mariana"), sign(f, "poder", "mariana"))),
        (2, "11:30", "request", lambda: request(f, "cargos", "laura", INV, L,
            "Confirmar si la nueva demanda mantiene solo el cargo del artículo 2 del Convenio 190",
            "Para el memo de la nueva demanda necesito saber si volvemos a incluir los cargos de los que se desistió "
            "en 2025 (artículo 93 de la Constitución y artículos 3 y 4 del Convenio).")),
        (2, "15:00", "ask", lambda: ask(f, "ricardo", "riesgo", G, [
            "¿Qué riesgo comercial tiene la fase 2 si la Corte declara inexequible la Ley 2528 de 2025?"])),
        (2, "16:00", "request", lambda: req_update(f, "cargos", "mariana", assignee="mariana", status="waiting",
            note="¿Puedes revisar primero cómo trató la Corte el artículo 93 en la Sentencia C-217? Con eso decidimos.")),
        (2, "16:30", "ask", lambda: ask(f, "mariana", "compromisos", G, [
            "¿Qué compromisos quedaron en el acta de reunión con el cliente del 28 de julio de 2026?"])),
        # Day 1: meeting with the client
        (1, "08:30", "ask", lambda: ask(f, "mariana", "agenda", G, [
            ("Prepara un documento en Word para la reunión con el cliente: qué decidió la Corte, estado del expediente "
             "LAT-506 y compromisos pendientes.", "docx")])),
        (1, "09:10", "request", lambda: req_update(f, "cargos", "laura",
            "Revisado: la Corte no estudió el fondo de ningún cargo. Sugiero mantener solo el artículo 2 del Convenio.")),
        (1, "14:30", "upload", lambda: upload(f, "tomas", G, "Acta de reunión con el cliente — 12 de noviembre",
                                              "acta-reunion-cliente-noviembre.txt", doc_acta_cliente(day(1)), cli)),
        (1, "15:10", "run", run("estrategia", "mariana", "contract_review",
            "Revisa la estrategia después del fallo y señala los riesgos para la próxima revisión del comité de litigio.")),
        (1, "16:00", "ask", lambda: ask(f, "tomas", "reunion-nov", G, [
            "¿Qué se decidió en la reunión con el cliente del 12 de noviembre de 2026?",
            "¿Cuándo debe enviarse el segundo informe trimestral al cliente?"])),
        (1, "17:00", "request", lambda: request(f, "fase2", "andres", A, L,
            "Visto bueno de los socios para facturar la fase 2",
            "Cuando se cumpla la condición del presupuesto de la fase 2 necesito el visto bueno para empezar a "
            "facturar. ¿Lo dejamos aprobado de una vez?", "high")),
        # Day 0: this morning
        (0, "08:20", "run", run("compromisos", "tomas", "answer_with_approval",
            "Prepara una respuesta para el cliente con los compromisos de la reunión del 12 de noviembre de 2026 y "
            "las fechas de entrega.")),
        (0, "08:50", "run", run("auditoria-acta", "laura", "audit_if_evidence",
            "Audita el acta de reunión con el cliente del 12 de noviembre: ¿quién es responsable de cada compromiso "
            "y en qué fecha?")),
        (0, "09:30", "ask", lambda: ask(f, "camilo", "procuraduria", G, [
            "¿Qué dijo la Procuraduría General de la Nación en el trámite de la Sentencia C-217 de 2026?"])),
        (0, "10:05", "request", lambda: req_update(f, "cobro", "daniela", status="waiting",
            note="Borrador listo. Mariana, ¿la reunión del 12 de noviembre se cobra aparte o dentro de la tarifa mensual?")),
        (0, "10:15", "ask", lambda: ask(f, "andres", "horas-tomas", A, [
            "¿Qué horas registró Tomás Rengifo Bernal en octubre en el caso Parra Rosas?"])),
    ]


def when(days_ago: int, hhmm: str) -> datetime:
    h, m = map(int, hhmm.split(":"))
    d = day(days_ago)
    return datetime(d.year, d.month, d.day, h, m, tzinfo=TZ)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--api", default="http://localhost:4000")
    ap.add_argument("--pg-container", default="ragsis-postgres-1")
    ap.add_argument("--dry-run", action="store_true", help="print the timeline and exit")
    args = ap.parse_args()

    sessions = {k: login(args.api, PEOPLE[k][0]) for k in PEOPLE}
    for email, name, _, _ in PEOPLE.values():  # display names: saved the first time a token that carries one is used
        r = httpx.post(f"{args.api}/v1/auth/dev-login", json={"email": email, "name": name}, timeout=30)
        r.raise_for_status()
        httpx.get(f"{args.api}/v1/me", headers={"authorization": f"Bearer {r.json()['token']}"}, timeout=30).raise_for_status()
    owner = sessions["mariana"]
    orgs = [o for o in owner.req("GET", "me").json()["organizations"] if o["name"] == ORG_NAME]
    if not orgs:
        print(f"«{ORG_NAME}» doesn't exist yet. Run `make seed-judicial` first.")
        return 1
    org = orgs[0]["id"]
    general = owner.req("GET", f"organizations/{org}/workspaces").json()["workspaces"][0]["id"]
    f = Firm(args.api, org, general, sessions, {k: s.user_id for k, s in sessions.items()})
    f.workflows = {}
    for w in f.r("mariana", "GET", "workflows").json()["workflows"]:
        d = f.r("mariana", "GET", f"workflows/{w['id']}").json()
        if d["status"] == "published":
            f.workflows.setdefault(d["template_code"], w["id"])

    timeline = story(f)
    start = datetime.now(TZ)
    today = [i for i, (n, *_) in enumerate(timeline) if n == 0]
    latest = start - timedelta(minutes=15)
    targets = [when(n, hhmm) for n, hhmm, *_ in timeline]
    if today and targets[today[-1]] > latest:  # running early in the morning: squeeze this morning's steps
        first = start.replace(hour=7, minute=30, second=0, microsecond=0)
        for k, i in enumerate(today):
            targets[i] = first + (latest - first) * (k / max(1, len(today) - 1))
    if args.dry_run:
        for (_, _, label, _), t in zip(timeline, targets, strict=True):
            print(f"  {t:%a %d %b %H:%M}  {label}")
        return 0

    pg = Pg(args.pg_container)
    clock = Clock(pg, org)
    begin = clock.now()
    first_day = when(10, "08:30")
    epoch = pg.one(f"SELECT extract(epoch FROM created_at) FROM organizations WHERE id = '{org}'")
    org_created = datetime.fromtimestamp(float(epoch), TZ)
    print(f"Living a week in «{ORG_NAME}» ({first_day:%d %b} → today).")
    if org_created > first_day + timedelta(days=1):
        gone = pg.one(f"SELECT count(*) FROM workflow_runs WHERE organization_id = '{org}'"
                      " AND idempotency_key LIKE 'seed-judicial-%'")
        pg.run(f"""
BEGIN;
CREATE TEMP TABLE gone ON COMMIT DROP AS
  SELECT id FROM workflow_runs WHERE organization_id = '{org}' AND idempotency_key LIKE 'seed-judicial-%';
CREATE TEMP TABLE gone_ids ON COMMIT DROP AS
  SELECT id::text AS id FROM gone UNION ALL SELECT a.id::text FROM approvals a JOIN gone g ON g.id = a.run_id;
DELETE FROM outbox_events WHERE organization_id = '{org}'
   AND (correlation_id IN (SELECT id FROM gone_ids) OR aggregate_id IN (SELECT id FROM gone_ids));
DELETE FROM audit_events a WHERE a.organization_id = '{org}'
   AND EXISTS (SELECT 1 FROM gone_ids g WHERE a.resource LIKE '%' || g.id || '%');
DELETE FROM workflow_runs WHERE id IN (SELECT id FROM gone);
COMMIT;""")
        clock.compress_existing(first_day, when(10, "12:30"), begin)
        print(f"  Setup moved to {first_day:%d %b}; {gone} runs from seed-judicial will be replayed on their days.")

    for (_, _, _, action), target in zip(timeline, targets, strict=True):
        mark = clock.now()
        action()
        clock.stamp(mark, target)
    time.sleep(3)
    clock.sweep(begin)
    # Accounts created by the first sign-in this morning: they "exist" since the day they joined the firm.
    pg.run(f"""UPDATE users u SET created_at = m.created_at FROM memberships m
                WHERE m.user_id = u.id AND m.organization_id = '{org}' AND u.created_at > m.created_at;""")
    clock.rechain_audit()
    print("\nDone. Sign in at http://localhost:3000 with any of these (no password):")
    for k in PEOPLE:
        print(f"  {PEOPLE[k][0]:28} {PEOPLE[k][1]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
