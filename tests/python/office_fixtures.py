"""Constructores mínimos de DOCX/PPTX/XLSX/PNG en memoria para pruebas (sin dependencias)."""

from __future__ import annotations

import io
import random
import zipfile

from ragsis_ingest.parsers.pdf_images import _png

NS = (
    'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" '
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" '
    'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" '
    'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
    'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" '
    'xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" '
    'xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math" '
    'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"'
)
REL_NS = 'xmlns="http://schemas.openxmlformats.org/package/2006/relationships"'
RT = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"


def png(width: int = 120, height: int = 90, seed: int = 1) -> bytes:
    """PNG RGB con ruido determinista (no comprimible: supera el mínimo de bytes de figura)."""
    rnd = random.Random(seed)  # noqa: S311 - datos de prueba deterministas
    return _png(width, height, 3, bytes(rnd.getrandbits(8) for _ in range(width * height * 3)))


def jpeg_header(width: int, height: int) -> bytes:
    sof = b"\xff\xc0\x00\x11\x08" + height.to_bytes(2, "big") + width.to_bytes(2, "big") + b"\x03" + b"\x00" * 9
    return b"\xff\xd8\xff\xe0\x00\x10JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00" + sof + b"\xff\xd9"


def _zip(parts: dict[str, bytes | str]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for name, data in parts.items():
            zf.writestr(name, data)
    return buf.getvalue()


def _rels(items: list[tuple[str, str, str]], external: list[tuple[str, str]] = ()) -> str:
    body = "".join(f'<Relationship Id="{i}" Type="{RT}/{t}" Target="{target}"/>' for i, t, target in items)
    body += "".join(f'<Relationship Id="{i}" Type="{RT}/hyperlink" Target="{u}" TargetMode="External"/>'
                    for i, u in external)
    return f"<Relationships {REL_NS}>{body}</Relationships>"


CHART = f"""<c:chartSpace {NS}><c:chart>
<c:title><c:tx><c:rich><a:p><a:r><a:t>Ingresos 2026</a:t></a:r></a:p></c:rich></c:tx></c:title>
<c:plotArea><c:barChart><c:ser>
 <c:tx><c:strRef><c:strCache><c:pt idx="0"><c:v>Ingresos</c:v></c:pt></c:strCache></c:strRef></c:tx>
 <c:cat><c:strRef><c:strCache><c:pt idx="0"><c:v>Q1</c:v></c:pt><c:pt idx="1"><c:v>Q2</c:v></c:pt></c:strCache></c:strRef></c:cat>
 <c:val><c:numRef><c:numCache><c:pt idx="0"><c:v>120.5</c:v></c:pt><c:pt idx="1"><c:v>340</c:v></c:pt></c:numCache></c:numRef></c:val>
</c:ser></c:barChart></c:plotArea></c:chart></c:chartSpace>"""


def _drawing_pic(rid: str, descr: str) -> str:
    return (f'<w:r><w:drawing><wp:inline><wp:docPr id="1" name="Imagen" descr="{descr}"/><a:graphic>'
            f'<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic>'
            f'<pic:blipFill><a:blip r:embed="{rid}"/></pic:blipFill></pic:pic></a:graphicData></a:graphic>'
            f"</wp:inline></w:drawing></w:r>")


def docx(image: bytes | None = None) -> bytes:
    image = image or png()
    body = f"""
<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Informe comercial</w:t></w:r></w:p>
<w:p><w:r><w:t>Las ventas del trimestre por región se resumen en la figura siguiente.</w:t></w:r></w:p>
<w:p>{_drawing_pic("rIdImg1", "Gráfico de ventas por región")}</w:p>
<w:p><w:pPr><w:pStyle w:val="Caption"/></w:pPr><w:r><w:t>Figura 1. Ventas por región</w:t></w:r></w:p>
<w:p><w:r><w:drawing><wp:inline><wp:docPr id="2" name="Chart"/><a:graphic>
<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart r:id="rIdChart1"/></a:graphicData>
</a:graphic></wp:inline></w:drawing></w:r></w:p>
<w:p><m:oMathPara><m:oMath><m:r><m:t>E=mc^2</m:t></m:r></m:oMath></m:oMathPara></w:p>
<w:p><w:r><w:t>Tabla 1. Metas por sede</w:t></w:r></w:p>
<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Sede</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Meta</w:t></w:r></w:p></w:tc></w:tr>
<w:tr><w:tc><w:p><w:r><w:t>Bogotá</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>500</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
<w:p>{_drawing_pic("rIdEmf", "")}</w:p>
"""
    return _zip({
        "[Content_Types].xml": "<Types/>",
        "word/document.xml": f"<w:document {NS}><w:body>{body}</w:body></w:document>",
        "word/_rels/document.xml.rels": _rels(
            [("rIdImg1", "image", "media/image1.png"), ("rIdChart1", "chart", "charts/chart1.xml"),
             ("rIdEmf", "image", "media/image2.emf")],
            external=[("rIdExt", "http://169.254.169.254/latest/meta-data")]),
        "word/media/image1.png": image,
        "word/media/image2.emf": b"\x01\x00\x00\x00EMF-not-supported" * 10,
        "word/charts/chart1.xml": CHART,
    })


def pptx(image: bytes | None = None, title: str = "Resultados del tercer trimestre") -> bytes:
    image = image or png(seed=7)
    slide = f"""<p:sld {NS}><p:cSld><p:spTree>
<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>
 <p:txBody><a:p><a:r><a:t>{title}</a:t></a:r></a:p></p:txBody></p:sp>
<p:sp><p:nvSpPr><p:cNvPr id="3" name="Body"/><p:cNvSpPr/><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr>
 <p:txBody><a:p><a:r><a:t>La planta de Medellín superó la meta de producción del trimestre.</a:t></a:r></a:p></p:txBody></p:sp>
<p:sp><p:nvSpPr><p:cNvPr id="9" name="Num"/><p:cNvSpPr/><p:nvPr><p:ph type="sldNum"/></p:nvPr></p:nvSpPr>
 <p:txBody><a:p><a:r><a:t>7</a:t></a:r></a:p></p:txBody></p:sp>
<p:pic><p:nvPicPr><p:cNvPr id="4" name="Picture" descr="Mapa de plantas"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>
 <p:blipFill><a:blip r:embed="rId3"/></p:blipFill>
 <p:spPr><a:xfrm><a:off x="1219200" y="685800"/><a:ext cx="6096000" cy="3429000"/></a:xfrm></p:spPr></p:pic>
<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="5" name="Tabla"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>
 <p:xfrm><a:off x="0" y="4114800"/><a:ext cx="6096000" cy="1371600"/></p:xfrm>
 <a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl>
  <a:tr><a:tc><a:txBody><a:p><a:r><a:t>Planta</a:t></a:r></a:p></a:txBody></a:tc><a:tc><a:txBody><a:p><a:r><a:t>Unidades</a:t></a:r></a:p></a:txBody></a:tc></a:tr>
  <a:tr><a:tc><a:txBody><a:p><a:r><a:t>Medellín</a:t></a:r></a:p></a:txBody></a:tc><a:tc><a:txBody><a:p><a:r><a:t>12400</a:t></a:r></a:p></a:txBody></a:tc></a:tr>
 </a:tbl></a:graphicData></a:graphic></p:graphicFrame>
<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="6" name="Chart"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>
 <p:xfrm><a:off x="6096000" y="4114800"/><a:ext cx="6096000" cy="1371600"/></p:xfrm>
 <a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart r:id="rId5"/></a:graphicData></a:graphic>
</p:graphicFrame>
</p:spTree></p:cSld></p:sld>"""
    notes = f"""<p:notes {NS}><p:cSld><p:spTree><p:sp><p:nvSpPr><p:cNvPr id="2" name="N"/><p:cNvSpPr/>
<p:nvPr><p:ph type="body"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>Mencionar el retraso logístico en Cali.</a:t>
</a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:notes>"""
    return _zip({
        "[Content_Types].xml": "<Types/>",
        "ppt/presentation.xml": f'<p:presentation {NS}><p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst>'
                                f'<p:sldSz cx="12192000" cy="6858000"/></p:presentation>',
        "ppt/_rels/presentation.xml.rels": _rels([("rId2", "slide", "slides/slide1.xml")]),
        "ppt/slides/slide1.xml": slide,
        "ppt/slides/_rels/slide1.xml.rels": _rels([("rId3", "image", "../media/image1.png"),
                                                    ("rId4", "notesSlide", "../notesSlides/notesSlide1.xml"),
                                                    ("rId5", "chart", "../charts/chart1.xml")]),
        "ppt/notesSlides/notesSlide1.xml": notes,
        "ppt/media/image1.png": image,
        "ppt/charts/chart1.xml": CHART,
    })


def xlsx() -> bytes:
    s = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' \
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'
    strings = ["Región", "Margen operativo", "Fecha de corte", "Andina", "Caribe", "Salarios"]
    sst = f"<sst {s}>" + "".join(f"<si><t>{x}</t></si>" for x in strings) + "</sst>"
    styles = (f'<styleSheet {s}><numFmts count="1"><numFmt numFmtId="164" formatCode="dd/mm/yyyy"/></numFmts>'
              '<cellXfs count="3"><xf numFmtId="0"/><xf numFmtId="9"/><xf numFmtId="164"/></cellXfs></styleSheet>')
    sheet1 = f"""<worksheet {s}><sheetData>
<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row>
<row r="2"><c r="A2" t="s"><v>3</v></c><c r="B2" s="1"><v>0.15</v></c><c r="C2" s="2"><v>46037</v></c></row>
<row r="3"><c r="A3" t="s"><v>4</v></c><c r="B3" s="1"><f>B2-0.025</f><v>0.125</v></c>
 <c r="C3" t="inlineStr"><is><t>pendiente</t></is></c></row>
</sheetData></worksheet>"""
    sheet2 = f'<worksheet {s}><sheetData><row r="1"><c r="A1" t="s"><v>5</v></c></row></sheetData></worksheet>'
    return _zip({
        "[Content_Types].xml": "<Types/>",
        "xl/workbook.xml": f'<workbook {s}><sheets><sheet name="Resumen" sheetId="1" r:id="rId1"/>'
                           f'<sheet name="Interna" sheetId="2" state="hidden" r:id="rId2"/></sheets></workbook>',
        "xl/_rels/workbook.xml.rels": _rels([("rId1", "worksheet", "worksheets/sheet1.xml"),
                                             ("rId2", "worksheet", "worksheets/sheet2.xml")]),
        "xl/sharedStrings.xml": sst,
        "xl/styles.xml": styles,
        "xl/worksheets/sheet1.xml": sheet1,
        "xl/worksheets/sheet2.xml": sheet2,
    })


def with_macro(data: bytes) -> bytes:
    buf = io.BytesIO(data)
    with zipfile.ZipFile(buf, "a") as zf:
        zf.writestr("xl/vbaProject.bin", b"\x00" * 64)
    return buf.getvalue()
