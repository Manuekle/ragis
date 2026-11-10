"""RAG-04 (unidad): parsers OOXML/imagen, validación, chunking multimodal, gateway con visión y adaptador Docling."""

from __future__ import annotations

import io
import zipfile
from types import SimpleNamespace

import pytest
from office_fixtures import docx, jpeg_header, png, pptx, with_macro, xlsx
from ragsis_ai.gateway import AIGateway, VisionDisabled
from ragsis_ai.policy import PolicyViolation
from ragsis_ai.providers.bedrock import anthropic_content, converse_content
from ragsis_ai.registry import CLOUD, DEFAULT_MODELS, LOCAL_NETWORK, ModelRegistry, ModelSpec
from ragsis_ai.types import DataClass, GenerationRequest, GenerationResult, ImageInput, ModelKind, TenantAIPolicy
from ragsis_ingest.chunker import Chunker
from ragsis_ingest.images import inspect_image
from ragsis_ingest.multimodal import verified_summary
from ragsis_ingest.parsers.docling_adapter import convert_document
from ragsis_ingest.parsers.docx import parse_docx
from ragsis_ingest.parsers.image import parse_image
from ragsis_ingest.parsers.model import Block
from ragsis_ingest.parsers.pdf_images import page_images
from ragsis_ingest.parsers.pptx import parse_pptx
from ragsis_ingest.parsers.xlsx import parse_xlsx
from ragsis_ingest.validation import ValidationError, validate

PPTX_MIME = "application/vnd.openxmlformats-officedocument.presentationml.presentation"
XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


# ---------------------------------------------------------------- imágenes y validación
def test_inspect_image_headers():
    p = png(100, 50)
    assert inspect_image(p).__dict__ == {"mime": "image/png", "width": 100, "height": 50}
    assert (inspect_image(jpeg_header(640, 480)).width, inspect_image(jpeg_header(640, 480)).height) == (640, 480)
    assert inspect_image(b"GIF89a" + (33).to_bytes(2, "little") + (11).to_bytes(2, "little")).mime == "image/gif"
    assert inspect_image(b"not an image") is None
    assert inspect_image(b"\x89PNG\r\n\x1a\n" + b"\x00" * 4) is None


def test_validation_accepts_office_and_images_rejects_macros_and_bombs(monkeypatch):
    for data, name, mime, kind in [(pptx(), "d.pptx", PPTX_MIME, "pptx"), (xlsx(), "d.xlsx", XLSX_MIME, "xlsx"),
                                   (png(), "p.png", "image/png", "image")]:
        assert validate(data, name, mime, len(data), 10_000_000).kind == kind
    bad = with_macro(xlsx())
    with pytest.raises(ValidationError) as e:
        validate(bad, "m.xlsx", XLSX_MIME, len(bad), 10_000_000)
    assert e.value.code == "macro_document"
    gif = b"GIF89a" + (33).to_bytes(2, "little") + (11).to_bytes(2, "little") + b"\x00" * 20
    with pytest.raises(ValidationError) as e:
        validate(gif, "a.gif", "image/gif", len(gif), 10_000_000)
    assert e.value.code == "unsupported_type"
    # MIME declarado distinto al detectado
    with pytest.raises(ValidationError) as e:
        validate(png(), "p.png", "image/jpeg", len(png()), 10_000_000)
    assert e.value.code == "mime_mismatch"
    # Bomba de píxeles: cabecera de 30000x30000 se rechaza sin decodificar nada.
    big = jpeg_header(30000, 30000)
    with pytest.raises(ValidationError) as e:
        validate(big, "b.jpg", "image/jpeg", len(big), 10_000_000)
    assert e.value.code == "image_too_large"


# ---------------------------------------------------------------- parsers
def test_docx_figures_captions_charts_equations():
    doc = parse_docx(docx())
    kinds = [b.kind for b in doc.blocks]
    assert kinds == ["heading", "paragraph", "figure", "table", "equation", "table"]
    fig = doc.blocks[2]
    assert fig.caption == "Figura 1. Ventas por región"                 # estilo Caption, debajo de la figura
    assert fig.meta["alt_text"] == "Gráfico de ventas por región" and fig.image_mime == "image/png"
    chart = doc.blocks[3]
    assert chart.caption == "Gráfico: Ingresos 2026" and "| Q1 | 120.5 |" in chart.text and chart.meta["source"] == "chart"
    assert doc.blocks[4].text == "E=mc^2"
    assert doc.blocks[5].caption == "Tabla 1. Metas por sede"           # caption por texto, encima de la tabla
    assert any("image2.emf" in w for w in doc.warnings)                  # EMF no se envía a un VLM
    # El destino externo (metadata de AWS) nunca se resuelve ni se descarga.
    assert not any("169.254" in (b.text + str(b.meta)) for b in doc.blocks)


def test_pptx_slides_bbox_tables_charts_notes():
    doc = parse_pptx(pptx(), max_pages=50)
    assert doc.page_count == 1 and doc.title == "Resultados del tercer trimestre"
    heading, body, fig, table, chart, notes = doc.blocks
    assert heading.text == "Diapositiva 1: Resultados del tercer trimestre" and heading.page == 1
    assert "Medellín" in body.text
    assert fig.kind == "figure" and fig.bbox == (0.1, 0.1, 0.6, 0.6) and fig.meta["alt_text"] == "Mapa de plantas"
    assert table.kind == "table" and "12400" in table.text and table.bbox == (0.0, 0.6, 0.5, 0.8)
    assert chart.caption.startswith("Gráfico") and "340" in chart.text
    assert notes.text.startswith("Notas del orador") and "Cali" in notes.text
    assert all(b.text != "7" for b in doc.blocks)                       # número de diapositiva omitido
    from ragsis_ingest.parsers.pdf import PageLimitExceeded
    with pytest.raises(PageLimitExceeded):
        parse_pptx(pptx(), max_pages=0)


def test_xlsx_formats_dates_percentages_and_skips_hidden_sheets():
    doc = parse_xlsx(xlsx(), max_pages=50)
    assert [b.kind for b in doc.blocks] == ["heading", "table"]
    table = doc.blocks[1].text
    assert "| Andina | 15% | 2026-01-15 |" in table
    assert "| Caribe | 12.5% | pendiente |" in table
    assert "Salarios" not in table and any("Interna" in w for w in doc.warnings)


def test_image_document_and_pdf_image_repack():
    doc = parse_image(png(200, 100))
    assert doc.blocks[0].kind == "figure" and doc.low_text_pages == [1] and doc.blocks[0].meta["whole_page"]

    class _Img(dict):
        def __init__(self, raw, **kw):
            super().__init__(**kw)
            self.raw = raw

        def get_object(self):
            return self

        def get_data(self):
            return self.raw

    raw = bytes(range(256)) * (64 * 48 * 3 // 256)
    xobjs = {"/Im1": _Img(raw, **{"/Subtype": "/Image", "/Width": 64, "/Height": 48, "/ColorSpace": "/DeviceRGB",
                                  "/BitsPerComponent": 8, "/Filter": "/FlateDecode"}),
             "/Im2": _Img(b"", **{"/Subtype": "/Image", "/Width": 9000, "/Height": 9000, "/ColorSpace": "/DeviceRGB",
                                  "/BitsPerComponent": 8})}
    res = _Img(b"", **{"/XObject": _Img(b"", **xobjs)})
    page = {"/Resources": res}
    imgs = page_images(page, max_pixels=40_000_000)
    assert len(imgs) == 1 and imgs[0][1] == "image/png"                  # la de 81 MP se descarta antes de inflar
    assert inspect_image(imgs[0][0]).__dict__ == {"mime": "image/png", "width": 64, "height": 48}


def test_docling_conversion_by_label():
    class Prov(SimpleNamespace):
        pass

    def item(label, **kw):
        return SimpleNamespace(label=SimpleNamespace(value=label), prov=[Prov(page_no=1, bbox=_BB())], self_ref=kw.pop(
            "ref", f"#/{label}"), **kw)

    class _BB:
        def to_top_left_origin(self, page_height):
            return SimpleNamespace(l=10, t=20, r=110, b=70)

    class _Pil:
        def save(self, buf, format):  # noqa: A002
            buf.write(png(80, 80))

    table = item("table", captions=[SimpleNamespace(cref="#/cap1")])
    table.export_to_markdown = lambda doc: "| a | b |\n|---|---|\n| 1 | 2 |"
    table.caption_text = lambda doc: "Tabla 2. Costos"
    pic = item("picture", captions=[])
    pic.get_image = lambda doc: _Pil()
    pic.caption_text = lambda doc: ""
    items = [item("page_header", text="CONFIDENCIAL"), item("title", text="Reporte anual"),
             item("section_header", text="Costos", level=1), item("text", text="Los costos bajaron."),
             item("caption", text="Tabla 2. Costos", ref="#/cap1"), table, pic, item("formula", text=r"\sum x_i")]
    doc = SimpleNamespace(tables=[table], pictures=[pic], pages={1: SimpleNamespace(size=SimpleNamespace(width=200, height=100))},
                          iterate_items=lambda: [(i, 0) for i in items])
    parsed = convert_document(doc, "2.x")
    assert [b.kind for b in parsed.blocks] == ["heading", "heading", "paragraph", "table", "figure", "equation"]
    assert parsed.title == "Reporte anual" and parsed.blocks[1].level == 2
    assert parsed.blocks[3].caption == "Tabla 2. Costos" and parsed.blocks[3].bbox == (0.05, 0.2, 0.55, 0.7)
    assert parsed.blocks[4].image_mime == "image/png" and parsed.blocks[5].meta["format"] == "latex"
    assert all("CONFIDENCIAL" not in b.text for b in parsed.blocks)       # encabezado de página omitido


# ---------------------------------------------------------------- chunking y resúmenes
def test_chunker_multimodal_chunks_keep_layout_and_assets():
    blocks = [Block("heading", "Ventas", level=1, page=2),
              Block("paragraph", "Texto introductorio de la sección de ventas.", page=2),
              Block("figure", "Figura 3. Mapa\nDescripción de la figura (generada por IA): mapa con tres plantas.", page=2,
                    bbox=(0.1, 0.2, 0.5, 0.6), asset_key="tenants/x/assets/a.png", caption="Figura 3. Mapa",
                    meta={"description_source": "vlm"}),
              Block("table", "| a | b |\n| 1 | 2 |", page=2, caption="Tabla 4. Datos", bbox=(0.0, 0.7, 1.0, 0.9),
                    meta={"summary": "La tabla muestra 1 y 2."}),
              Block("equation", "E=mc^2", page=3)]
    chunks = Chunker().chunk(blocks)
    fig = next(c for c in chunks if c.kind == "figure")
    assert fig.bbox == (0.1, 0.2, 0.5, 0.6) and fig.asset_key == "tenants/x/assets/a.png"
    assert fig.section_path == "Ventas" and fig.meta["caption"] == "Figura 3. Mapa" and fig.page_start == 2
    table = next(c for c in chunks if c.kind == "table")
    assert table.text.startswith("Tabla 4. Datos\nResumen de la tabla (generado por IA): La tabla muestra 1 y 2.")
    assert table.bbox == (0.0, 0.7, 1.0, 0.9)
    assert next(c for c in chunks if c.kind == "equation").text == "E=mc^2"


def test_table_summary_drops_unverifiable_numbers():
    table = "| Sede | Ventas |\n| Bogotá | 1.200 |\n| Cali | 800 |"
    s = verified_summary("La tabla compara ventas por sede. Bogotá vendió 1200 unidades. El total fue 2000 unidades.", table)
    assert "1200" in s and "2000" not in s and "compara" in s


# ---------------------------------------------------------------- gateway con visión
class _Recorder:
    name = "fake"

    def __init__(self):
        self.calls = []

    def generate(self, model, request):
        self.calls.append((model.model_id, len(request.images)))
        return GenerationResult(f"desc:{model.model_id}", model.model_id, 10, 5)


def _gateway(*extra, fallbacks=None):
    reg = ModelRegistry(DEFAULT_MODELS + extra, fallbacks={"cloud-vlm@v1": ("local-vlm@v1",),
                                                           "cloud-gen-vision@v1": ("local-gen@v1",)}
                        if fallbacks is None else fallbacks)
    rec = _Recorder()
    return AIGateway(reg, {"fake": rec}), rec


CLOUD_VLM = ModelSpec("cloud-vlm@v1", ModelKind.VISION, "fake", "c", CLOUD, regions=("us-east-1",), vision=True)
LOCAL_VLM = ModelSpec("local-vlm@v1", ModelKind.VISION, "fake", "l", LOCAL_NETWORK, vision=True)
IMG = ImageInput(png(), "image/png", "Imagen")


def test_describe_respects_policy_and_vision_capability(monkeypatch):
    from ragsis_core.settings import get_settings

    gw, rec = _gateway(CLOUD_VLM, LOCAL_VLM)
    req = GenerationRequest("s", "p", "", (), 300, (IMG,))
    monkeypatch.setenv("AI_VISION_MODEL", "")
    get_settings.cache_clear()
    with pytest.raises(VisionDisabled):
        gw.describe(req, TenantAIPolicy())
    # Internal: usa el VLM cloud. Restricted: la cadena cae al VLM local; nunca toca la nube.
    assert gw.describe(req, TenantAIPolicy(), model_id="cloud-vlm@v1").model_id == "cloud-vlm@v1"
    assert gw.describe(req, TenantAIPolicy(data_class=DataClass.RESTRICTED), model_id="cloud-vlm@v1").model_id == "local-vlm@v1"
    assert rec.calls == [("cloud-vlm@v1", 1), ("local-vlm@v1", 1)]
    assert gw.calls[-1].kind == "vision"
    gw2, _ = _gateway(CLOUD_VLM, fallbacks={})
    with pytest.raises(PolicyViolation):
        gw2.describe(req, TenantAIPolicy(data_class=DataClass.RESTRICTED), model_id="cloud-vlm@v1")
    with pytest.raises(ValueError):
        gw.describe(req, TenantAIPolicy(), model_id="local-extractive@v1")   # sin visión
    get_settings.cache_clear()


def test_generate_strips_images_for_non_vision_fallback():
    gen_v = ModelSpec("cloud-gen-vision@v1", ModelKind.GENERATE, "fake", "g", CLOUD, regions=("us-east-1",), vision=True)
    gen_t = ModelSpec("local-gen@v1", ModelKind.GENERATE, "fake", "t", LOCAL_NETWORK)
    gw, rec = _gateway(gen_v, gen_t)
    req = GenerationRequest("s", "p", "q", (), 300, (IMG,))
    gw.generate(req, TenantAIPolicy(), model_id="cloud-gen-vision@v1")
    gw.generate(req, TenantAIPolicy(data_class=DataClass.RESTRICTED), model_id="cloud-gen-vision@v1")
    assert rec.calls == [("cloud-gen-vision@v1", 1), ("local-gen@v1", 0)]


def test_provider_payloads_label_each_image():
    nova = ModelRegistry().get("bedrock-nova-lite@v1")
    micro = ModelRegistry().get("bedrock-nova-micro@v1")
    req = GenerationRequest("s", "prompt", "", (), 100, (ImageInput(b"\x89PNG", "image/png", "Image for source [2]"),))
    content = converse_content(nova, req)
    assert content[0] == {"text": "Image for source [2]"} and content[1]["image"]["format"] == "png"
    assert content[-1] == {"text": "prompt"}
    assert converse_content(micro, req) == [{"text": "prompt"}]          # Nova Micro no tiene visión
    claude = ModelRegistry().get("bedrock-claude-sonnet-5-5@v1")
    ac = anthropic_content(claude, req)
    assert ac[1]["type"] == "image" and ac[1]["source"]["media_type"] == "image/png"
    with pytest.raises(ValueError):
        ImageInput(b"x", "image/tiff")


def test_zip_bomb_guard_still_applies_to_new_formats():
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("ppt/presentation.xml", "<p/>")
        zf.writestr("../evil.xml", "x")
    data = buf.getvalue()
    with pytest.raises(ValidationError) as e:
        validate(data, "x.pptx", PPTX_MIME, len(data), 10_000_000)
    assert e.value.code == "zip_path_traversal"
