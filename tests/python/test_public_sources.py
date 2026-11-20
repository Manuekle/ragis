"""Public records in Ask (ADR-036): planner, Croma client, evidence and the orchestrator with a fake Croma."""

import dataclasses
import json

import httpx
import pytest
from ragsis_core.internal_auth import InternalClaims, issue_internal_token, verify_internal_token
from ragsis_rag.orchestrator import QueryOrchestrator
from ragsis_rag.public_sources import PublicClaim, run_lookup
from ragsis_rag.public_sources.catalog import countries_in, endpoints_for, load_catalog
from ragsis_rag.public_sources.client import CromaClient, CromaError
from ragsis_rag.public_sources.evidence import items_from_response
from ragsis_rag.public_sources.fake import FakeCromaClient
from ragsis_rag.public_sources.planner import make_plan, parse_plan, search_terms, validate_call

CAT = load_catalog()


# --------------------------------------------------------------------------- catalog
def test_catalog_excludes_personal_lookups():
    personal = {"policia-criminal-records", "adres-affiliation-status", "ruaf-affiliations", "bancolombia-accounts",
                "runt-citizen-by-document", "sunat-document", "dian-muisca-electronic-invoices",
                "registraduria-vital-status", "sat-lima-account-status"}
    assert not personal & set(CAT)
    assert all(e.path.startswith("/") and ".." not in e.path for e in CAT.values())
    assert {"rues-entities-by-name", "web-search", "ofac-sanctions-screen"} <= set(CAT)


def test_countries_in_question():
    assert countries_in("¿Qué sanciones tiene la empresa en Perú y en México?") == ["mx", "pe"]
    assert countries_in("noticias internacionales del café") == ["global"]
    assert countries_in("política de viáticos") == []


# --------------------------------------------------------------------------- planner
def test_validate_call_drops_unknown_and_enforces_schema():
    rues = CAT["rues-entities-by-name"]
    call = validate_call(rues, {"name": "  Rappi   SAS ", "evil": "x", "page": 999999})
    assert call.params == {"name": "Rappi SAS", "page": 1000}
    assert validate_call(rues, {"name": "ab"}) is None           # minLength 3
    assert validate_call(rues, {}) is None                       # required missing
    web = CAT["web-search"]
    assert validate_call(web, {"query": "café Colombia", "limit": 25}).params["limit"] == 5   # paging capped
    dof = CAT["dof-publications-by-date"]
    assert validate_call(dof, {"date": "13/11/2026"}) is None    # pattern yyyy-mm-dd
    assert validate_call(dof, {"date": "2026-11-13"}).params == {"date": "2026-11-13"}


def test_parse_plan_only_accepts_the_shortlist():
    shortlist = endpoints_for(["co"], web=True)
    text = ('Sure! {"calls": [{"id": "rues-entities-by-name", "params": {"name": "Rappi"}}, '
            '{"id": "policia-criminal-records", "params": {"document_number": "123"}}, '
            '{"id": "ofac-sanctions-screen", "params": {"name": "Rappi"}}]}')
    calls = parse_plan(text, shortlist, 2)
    assert [c.endpoint.id for c in calls] == ["rues-entities-by-name"]   # not allowlisted / other country dropped
    assert parse_plan("I can't decide", shortlist, 2) is None
    assert parse_plan('{"calls": []}', shortlist, 2) == []


def test_keyword_plan_without_model():
    p = make_plan("¿Tiene procesos judiciales RAPPI S.A.S. en Colombia?", "pe", True, 2)
    assert p.planner == "keywords" and p.countries == ["co"]
    assert p.calls[0].endpoint.id == "rama-judicial-cases-by-entity"
    assert p.calls[0].params["name"].startswith("RAPPI")
    # Internal questions never fall back to the web.
    assert make_plan("¿Cuál es nuestra política de vacaciones?", "co", True, 2).calls == []
    # No country anywhere: worldwide tools only.
    p = make_plan("noticias sobre aranceles al café", None, True, 2)
    assert p.calls and p.calls[0].endpoint.id == "web-search"
    assert make_plan("noticias sobre aranceles al café", None, False, 2).calls == []
    assert search_terms('Busca "Alpina Productos" en RUES') == "Alpina Productos"


def test_llm_plan_used_and_question_only():
    seen = {}

    def generate(system, prompt):
        seen["prompt"] = prompt
        return '{"calls": [{"id": "secop-contracts-search", "params": {"query": "Rappi"}}]}', False

    p = make_plan("¿Qué contratos públicos tiene Rappi?", "co", True, 2, generate)
    assert p.planner == "llm" and [c.endpoint.id for c in p.calls] == ["secop-contracts-search"]
    assert "<question>¿Qué contratos públicos tiene Rappi?</question>" in seen["prompt"]
    # A local (extractive) model's text is never parsed as a plan.
    p = make_plan("¿Qué contratos públicos tiene Rappi?", "co", True, 2, lambda s, q: ('{"calls": []}', True))
    assert p.planner == "keywords"


def test_override_country_and_worldwide():
    p = make_plan("leyes sobre teletrabajo", "co", True, 2, override_country="cl")
    assert p.countries == ["cl"] and p.calls[0].endpoint.country == "cl"
    p = make_plan("leyes sobre teletrabajo", "co", True, 2, override_country="global")
    assert p.countries == [] and all(c.endpoint.country == "global" for c in p.calls)


# --------------------------------------------------------------------------- evidence
def test_items_from_web_search_and_no_match():
    web = CAT["web-search"]
    items = items_from_response(web, {"query": "café"}, {"results": [
        {"url": "https://example.org/a", "title": "Café exports", "highlights": ["Exports rose 5%."]},
        {"url": "javascript:alert(1)", "title": "bad"}]})
    assert len(items) == 1 and items[0].url == "https://example.org/a" and items[0].kind == "web"
    assert "Exports rose 5%." in items[0].text and items[0].source == "example.org"
    rues = CAT["rues-entities-by-name"]
    empty = items_from_response(rues, {"name": "Nadie SAS"}, {"query": "Nadie SAS", "entities": []})
    assert empty[0].no_match and "no matching records for “Nadie SAS”" in empty[0].text


def test_items_from_registry_list():
    ep = CAT["corte-constitucional-rulings-search"]
    data = {"as_of": "2026-11-01", "total": 40, "results": [
        {"id": "x1", "number": "T-123/26", "subject": "Derecho al trabajo", "reporting_judges": ["A", "B"],
         "official_url": "https://www.corteconstitucional.gov.co/relatoria/2026/T-123-26.htm"}]}
    items = items_from_response(ep, {"query": "trabajo"}, data)
    it = items[0]
    assert it.as_of == "2026-11-01" and it.url.endswith("T-123-26.htm")
    assert "matched 40 records" in it.text and "Reporting judges: A, B" in it.text and "x1" not in it.text
    assert it.title.endswith("T-123/26 · Derecho al trabajo") and "for the search “trabajo”" in it.text


# --------------------------------------------------------------------------- client
def _client(handler) -> CromaClient:
    return CromaClient("https://api.croma.run", "croma_test_key", 10, transport=httpx.MockTransport(handler))


def test_client_success_cache_pending_and_errors():
    ep = CAT["rues-entities-by-name"]
    seen = {}

    def ok(req: httpx.Request):
        seen["url"], seen["auth"], seen["body"] = str(req.url), req.headers["authorization"], json.loads(req.content)
        return httpx.Response(200, json={"data": {"entities": []}}, headers={"x-request-id": "req_1"})

    r = _client(ok).call(ep, {"name": "Rappi"})
    assert seen == {"url": "https://api.croma.run/co/rues/entities-by-name/v1", "auth": "Bearer croma_test_key",
                    "body": {"name": "Rappi"}}
    assert r.credits == 10 and r.request_id == "req_1" and not r.cached
    hit = _client(lambda q: httpx.Response(200, json={"data": {}}, headers={"x-cache": "HIT"})).call(ep, {"name": "x"})
    assert hit.cached and hit.credits == 0
    assert _client(lambda q: httpx.Response(202, json={"id": "job_1"})).call(ep, {"name": "x"}).pending
    for status, code in ((402, "credits_exhausted"), (429, "rate_limited"), (503, "source_unavailable"),
                         (401, "not_configured")):
        with pytest.raises(CromaError) as exc:
            _client(lambda q, s=status: httpx.Response(s, json={"error": {"code": "x"}})).call(ep, {"name": "x"})
        assert exc.value.code == code
    with pytest.raises(CromaError) as exc:
        CromaClient("https://api.croma.run", "", 10).call(ep, {"name": "x"})
    assert exc.value.code == "not_configured"


def test_run_lookup_reports_failures_without_raising():
    class Down:
        demo = False

        def call(self, endpoint, params):
            raise CromaError("credits_exhausted", 402)

    out = run_lookup("¿Tiene procesos judiciales RAPPI en Colombia?", PublicClaim("co", True, 2), None, Down())
    assert out.items == [] and out.lookups == 0 and out.unavailable == "credits_exhausted"
    assert out.refs[0]["status"] == "credits_exhausted" and "RAPPI" not in json.dumps(out.refs)
    assert run_lookup("x", PublicClaim("co", True, 2), None, None).unavailable == "not_configured"


# --------------------------------------------------------------------------- token
def test_public_claim_only_from_signed_token(settings_env):
    base = InternalClaims(*([__import__("uuid").uuid4()] * 3), ("user:x",), "team", "internal", (), 6000, False)
    assert verify_internal_token(issue_internal_token(base)).public_sources is None
    with_pub = dataclasses.replace(base, public_sources={"country": "co", "web": True, "max_calls": 2,
                                                         "override": None})
    got = verify_internal_token(issue_internal_token(with_pub)).public_sources
    assert got == {"country": "co", "web": True, "max_calls": 2, "override": None}
    zero = dataclasses.replace(base, public_sources={"country": "co", "web": True, "max_calls": 0})
    assert verify_internal_token(issue_internal_token(zero)).public_sources is None


# --------------------------------------------------------------------------- orchestrator (DB)
def test_orchestrator_answers_from_public_records(make_tenant, app_pool, owner):
    tenant = make_tenant("croma")
    fake = FakeCromaClient()
    rag = QueryOrchestrator(pool=app_pool, lookup_client=fake)
    claims = dataclasses.replace(tenant.claims(), public_sources={"country": "co", "web": True, "max_calls": 2,
                                                                  "override": None})
    q = "¿Tiene procesos judiciales RAPPI S.A.S. en Colombia?"
    res = rag.run(claims, q)
    assert not res.abstained, res.answer
    ext = [c for c in res.citations if c.get("external")]
    assert ext and ext[0]["kind"] == "public_record" and ext[0]["document_id"] is None and ext[0]["demo"]
    assert res.public_sources["lookups"] == 1 and res.public_sources["sources"] == ["Rama Judicial"]
    assert res.usage["public_lookups"] == 1 and res.usage["public_credits"] == 10
    assert fake.calls == [("rama-judicial-cases-by-entity", {"name": "RAPPI S.A.S"})]

    run = owner.execute("SELECT retrieved_refs AS r FROM query_runs WHERE id=%s", (res.trace_id,)).fetchone()["r"]
    public_refs = [r for r in run if r.get("kind") == "public_lookup"]
    assert public_refs and public_refs[0]["endpoint"] == "rama-judicial-cases-by-entity"
    assert "RAPPI" not in json.dumps(run)          # search terms are never stored
    n_cit = owner.execute("SELECT count(*) AS n FROM citations WHERE query_run_id=%s", (res.trace_id,)).fetchone()["n"]
    assert n_cit == 0                               # no document citation rows for public records
    used = owner.execute("SELECT sum(quantity) AS n FROM usage_events WHERE organization_id=%s "
                         "AND kind='public_lookups'", (tenant.org,)).fetchone()["n"]
    assert used == 1


def test_orchestrator_without_claim_never_calls_croma(make_tenant, app_pool):
    tenant = make_tenant("croma-off")
    fake = FakeCromaClient()
    res = QueryOrchestrator(pool=app_pool, lookup_client=fake).run(tenant.claims(),
                                                                   "¿Tiene procesos judiciales RAPPI en Colombia?")
    assert res.abstained and res.public_sources is None and fake.calls == []
