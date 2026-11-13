"""Builds the judicial evaluation corpus around Sentencia C-217 de 2026 (expediente D-16.857).

The sentence PDF is the real public decision of the Colombian Constitutional Court. Every other document is a
fictional law-firm file built to be consistent with it, so the golden set (eval/golden/judicial.yaml) can ask
questions that need a specific format (DOCX, XLSX, PPTX, TXT, HTML) or two documents at once.

Run from the repository root (dependencies stay out of the project environment):

    uv run --with python-docx --with openpyxl --with python-pptx python eval/corpus/judicial/build_corpus.py
"""

from __future__ import annotations

from pathlib import Path

from docx import Document
from docx.shared import Pt
from openpyxl import Workbook
from openpyxl.styles import Font
from pptx import Presentation
from pptx.util import Inches, Pt as PPt

OUT = Path(__file__).resolve().parent
FIRM = "Ortiz Lozano Abogados S.A.S."


def correccion_demanda() -> None:
    d = Document()
    d.styles["Normal"].font.size = Pt(11)
    d.add_heading("Escrito de corrección de la demanda de inconstitucionalidad", level=1)
    for line in (
        "Honorables Magistrados de la Corte Constitucional — Despacho del magistrado (e.) Juan Jacobo Calderón Villegas",
        "Referencia: expediente D-16.857. Demanda contra el parágrafo del artículo 1º de la Ley 1010 de 2006.",
        "Demandante: Juan Felipe Parra Rosas, identificado con cédula de ciudadanía 1.020.734.581.",
        f"Apoderada: Mariana Ortiz Lozano, tarjeta profesional 287.415 del C. S. de la J., socia de {FIRM}",
        "Fecha de radicación: 29 de septiembre de 2025, dentro del término de tres días concedido en el auto "
        "inadmisorio del 22 de septiembre de 2025. El escrito consta de 14 folios.",
    ):
        d.add_paragraph(line)
    d.add_heading("1. Desistimiento parcial", level=2)
    d.add_paragraph(
        "El demandante desiste de los cargos formulados por violación del artículo 93 de la Constitución y de los "
        "artículos 3 y 4 del Convenio 190 de la OIT. La demanda se mantiene únicamente por el cargo de violación del "
        "artículo 2 del Convenio 190 de la OIT, aprobado mediante la Ley 2528 de 2025.")
    d.add_heading("2. Concepto de la violación corregido", level=2)
    d.add_paragraph(
        "El artículo 2 del Convenio 190 protege a los trabajadores y a otras personas en el mundo del trabajo, "
        "cualquiera que sea su situación contractual. El parágrafo acusado excluye de la Ley 1010 de 2006 a los "
        "contratistas de prestación de servicios sin subordinación y a la contratación administrativa. Según el "
        "Departamento Administrativo de la Función Pública, en 2024 había 412.600 contratos de prestación de "
        "servicios vigentes en entidades del orden nacional, personas que hoy no pueden acudir a los comités de "
        "convivencia laboral.")
    d.add_heading("3. Ausencia de cosa juzgada", level=2)
    d.add_paragraph(
        "La Sentencia C-960 de 2007 resolvió un cargo de igualdad (artículos 1, 2 y 13 de la Constitución). El cargo "
        "actual tiene un parámetro distinto, por lo que no hay identidad de causa.")
    d.add_heading("4. Pretensiones", level=2)
    d.add_paragraph("Primera. Declarar inexequible el parágrafo del artículo 1º de la Ley 1010 de 2006.")
    d.add_paragraph(
        "Segunda. Ordenar al Ministerio del Trabajo reglamentar, en un plazo de seis meses, la aplicación de las "
        "normas sobre acoso laboral a las relaciones de empleo no subordinadas.")
    d.save(OUT / "correccion-demanda.docx")


def memorando_honorarios() -> None:
    d = Document()
    d.add_heading("Memorando confidencial — Honorarios y presupuesto del caso Parra Rosas", level=1)
    d.add_paragraph("Uso exclusivo de los socios. No compartir con asociados ni con el cliente.")
    d.add_paragraph(
        "Honorarios pactados para la fase de control abstracto (expediente D-16.857): 42.000.000 pesos, pagados en "
        "dos cuotas. La cuota de éxito de 15.000.000 pesos no se causó porque la Corte se inhibió.")
    d.add_paragraph(
        "Presupuesto aprobado para la nueva demanda (fase 2): 27.500.000 pesos, condicionado a que el Convenio 190 "
        "de la OIT sea ratificado. Responsable de facturación: Andrés Felipe Quintana.")
    d.add_paragraph(
        "Riesgo comercial: si la Corte declara inexequible la Ley 2528 de 2025 en el expediente LAT-506, la fase 2 "
        "se cancela y no habrá honorarios adicionales.")
    d.save(OUT / "memorando-honorarios.docx")


def cronologia() -> None:
    wb = Workbook()
    ws = wb.active
    ws.title = "Actuaciones"
    rows = [
        ("Fecha", "Actuación", "Expediente", "Responsable del seguimiento", "Estado"),
        ("2025-09-03", "Radicación de la demanda", "D-16.857", "Mariana Ortiz Lozano", "Cumplida"),
        ("2025-09-22", "Auto inadmite la demanda", "D-16.857", "Mariana Ortiz Lozano", "Cumplida"),
        ("2025-09-29", "Radicación del escrito de corrección", "D-16.857", "Mariana Ortiz Lozano", "Cumplida"),
        ("2025-10-16", "Auto admite la demanda y decreta pruebas", "D-16.857", "Tomás Rengifo Bernal", "Cumplida"),
        ("2025-12-02", "Auto reitera requerimiento de pruebas", "D-16.857", "Tomás Rengifo Bernal", "Cumplida"),
        ("2026-02-06", "Auto ordena continuar el trámite", "D-16.857", "Tomás Rengifo Bernal", "Cumplida"),
        ("2026-02-13", "Inicio de la fijación en lista", "D-16.857", "Tomás Rengifo Bernal", "Cumplida"),
        ("2026-02-27", "Vencimiento de la fijación en lista", "D-16.857", "Tomás Rengifo Bernal", "Cumplida"),
        ("2026-07-23", "Sentencia C-217 de 2026", "D-16.857", "Mariana Ortiz Lozano", "Notificada"),
        ("2026-08-15", "Revisión mensual del control automático", "LAT-506", "Laura Méndez Quintero", "Pendiente"),
    ]
    for r in rows:
        ws.append(r)
    for c in ws[1]:
        c.font = Font(bold=True)

    ws2 = wb.create_sheet("Intervinientes")
    for r in [
        ("Interviniente", "Postura", "Argumento principal"),
        ("Procuraduría General de la Nación", "Inhibición", "Convenio 190 no ratificado; derogatoria tácita por el artículo 18 de la Ley 2466 de 2025"),
        ("Fundación Jacarandas", "Inhibición", "Falta de un parámetro constitucional vigente"),
        ("Instituto Colombiano de Derecho Procesal", "Inhibición", "Aprobación legislativa y ratificación son actos distintos"),
        ("Universidad Libre", "Inexequibilidad", "El artículo 25 protege el trabajo en todas sus modalidades"),
        ("Universidad de Caldas", "Inexequibilidad", "La protección no debe depender de la formalidad del vínculo"),
        ("Unión de Trabajadores de Colombia", "Inexequibilidad", "En subsidio, exequibilidad condicionada para contratistas"),
        ("Universidad Militar Nueva Granada", "Exequibilidad condicionada", "Aplicar la ley a toda relación de subordinación en la función pública"),
        ("Universidad Externado de Colombia", "Sin solicitud expresa", "Posible derogatoria tácita por la Ley 2466 de 2025"),
    ]:
        ws2.append(r)
    for c in ws2[1]:
        c.font = Font(bold=True)

    ws3 = wb.create_sheet("Horas")
    for r in [
        ("Abogado", "Rol", "Horas registradas", "Tarifa por hora (COP)"),
        ("Mariana Ortiz Lozano", "Socia", 64, 450000),
        ("Tomás Rengifo Bernal", "Asociado", 118, 210000),
        ("Laura Méndez Quintero", "Asociada", 37, 210000),
    ]:
        ws3.append(r)
    for c in ws3[1]:
        c.font = Font(bold=True)
    wb.save(OUT / "cronologia-expediente.xlsx")


def estrategia() -> None:
    p = Presentation()
    s = p.slides.add_slide(p.slide_layouts[0])
    s.shapes.title.text = "Caso Parra Rosas: estrategia después de la Sentencia C-217 de 2026"
    s.placeholders[1].text = f"{FIRM} · Comité de litigio del 30 de julio de 2026"

    s = p.slides.add_slide(p.slide_layouts[1])
    s.shapes.title.text = "Lectura del fallo"
    body = s.placeholders[1].text_frame
    body.text = "La Corte no estudió el fondo: la decisión inhibitoria deja abierta una nueva demanda."
    for t in ("El obstáculo fue la falta de un parámetro de control vigente, no el contenido del cargo.",
              "No hubo pronunciamiento sobre la derogatoria tácita por la Ley 2466 de 2025.",
              "Lección: no radicar de nuevo hasta que el Convenio 190 esté ratificado y depositado ante la OIT."):
        body.add_paragraph().text = t

    s = p.slides.add_slide(p.slide_layouts[5])
    s.shapes.title.text = "Escenarios evaluados"
    data = [
        ("Escenario", "Probabilidad estimada", "Acción"),
        ("LAT-506 declara exequible el Convenio y se ratifica en 2027", "55%", "Nueva demanda en el primer trimestre de 2028"),
        ("LAT-506 se demora más de 18 meses", "30%", "Acción de tutela en casos concretos de contratistas"),
        ("LAT-506 declara inexequible la Ley 2528 de 2025", "15%", "Archivar el caso y cerrar la fase 2"),
    ]
    tbl = s.shapes.add_table(len(data), 3, Inches(0.4), Inches(1.6), Inches(9.2), Inches(2.6)).table
    for i, row in enumerate(data):
        for j, val in enumerate(row):
            tbl.cell(i, j).text = val
            tbl.cell(i, j).text_frame.paragraphs[0].runs[0].font.size = PPt(13)

    s = p.slides.add_slide(p.slide_layouts[1])
    s.shapes.title.text = "Decisión del comité"
    body = s.placeholders[1].text_frame
    body.text = "Estrategia recomendada: esperar el fallo del expediente LAT-506 y preparar la nueva demanda."
    body.add_paragraph().text = "Responsable de la nueva demanda: Mariana Ortiz Lozano."
    body.add_paragraph().text = "Próxima revisión del comité: 15 de octubre de 2026."
    p.save(OUT / "estrategia-post-fallo.pptx")


def acta_reunion() -> None:
    (OUT / "acta-reunion-cliente.txt").write_text(
        f"""ACTA DE REUNIÓN CON EL CLIENTE
{FIRM}

Fecha: 28 de julio de 2026, 10:00 a. m.
Lugar: sala de juntas, oficina de Bogotá (calle 93 # 11-26)
Asistentes: Juan Felipe Parra Rosas (cliente), Mariana Ortiz Lozano (socia), Tomás Rengifo Bernal (asociado).

1. Explicación del fallo
La socia explicó que en la Sentencia C-217 de 2026 la Corte no resolvió si el parágrafo es constitucional: se
inhibió. El cliente preguntó si podía volver a demandar. Se le explicó que sí, porque una decisión inhibitoria no
hace tránsito a cosa juzgada.

2. Decisiones
- El cliente autoriza preparar una nueva demanda, que solo se radicará cuando se cumpla la condición que señaló la
  Fundación Jacarandas en su intervención ante la Corte.
- El cliente pide recibir un informe trimestral sobre el expediente de control automático de la ley aprobatoria del
  Convenio.
- No se presentará solicitud de nulidad de la sentencia: el cliente la descartó por costos y baja probabilidad.

3. Compromisos
- Tomás Rengifo Bernal enviará el primer informe trimestral el 30 de octubre de 2026.
- Mariana Ortiz Lozano preparará un borrador de la nueva demanda antes del 31 de enero de 2027.

Próxima reunión: 12 de noviembre de 2026.
""",
        encoding="utf-8",
    )


def boletin() -> None:
    (OUT / "boletin-jurisprudencia.html").write_text(
        """<!doctype html>
<html lang="es"><head><meta charset="utf-8"><title>Boletín de jurisprudencia laboral n.º 47</title></head>
<body>
<h1>Boletín de jurisprudencia laboral n.º 47 — agosto de 2026</h1>
<p>Edición preparada por el área de derecho laboral y constitucional. Editora: Laura Méndez Quintero.</p>
<h2>1. Sentencia C-217 de 2026: la Corte se inhibe sobre la exclusión de contratistas de la Ley 1010</h2>
<p>La Sala Plena declaró la ineptitud sustantiva de la demanda contra el parágrafo del artículo 1º de la Ley 1010 de
2006. El Convenio 190 de la OIT todavía no es parámetro de control: la ley aprobatoria está en revisión.</p>
<h2>2. Antecedente: Sentencia C-960 de 2007</h2>
<p>En 2007 la Corte declaró exequible la misma exclusión, en el entendido de que si en realidad existe una relación
laboral se aplica la Ley 1010 de 2006 (principio de primacía de la realidad).</p>
<h2>3. Dato del mes</h2>
<table>
<tr><th>Indicador</th><th>Valor</th></tr>
<tr><td>Quejas por acoso laboral recibidas por el Ministerio del Trabajo en el primer semestre de 2026</td><td>3.214</td></tr>
<tr><td>Quejas presentadas por contratistas de prestación de servicios</td><td>587</td></tr>
</table>
<p>Fuente: Ministerio del Trabajo, informe de inspección de julio de 2026.</p>
</body></html>
""",
        encoding="utf-8",
    )


if __name__ == "__main__":
    correccion_demanda()
    memorando_honorarios()
    cronologia()
    estrategia()
    acta_reunion()
    boletin()
    print("corpus judicial generado en", OUT)
