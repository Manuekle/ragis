"""Harness de evaluación contra la API pública (caja negra).

Provisiona tenants/usuarios/grupos vía API, carga el corpus con upload prefirmado, espera
la indexación y ejecuta el golden set. Métricas (sección 13 del plan):

  answer_accuracy      respondibles cuya respuesta contiene los hechos esperados
  evidence_hit_rate    respondibles cuyo(s) documento(s) esperado(s) aparecen todos en las citas (`doc` o `docs`)
  citation_precision   citas que apuntan a un documento esperado (respondibles)
  abstention_precision abstenciones correctas / abstenciones totales
  abstention_recall    preguntas sin respuesta en las que se abstuvo
  acl_leakage          respuestas con contenido o citas no autorizadas (meta: 0)
  latency p50/p95      end-to-end vía API
  multi_hop_accuracy   (informativa, RAG-05) respondibles `multi_hop` correctas y con evidencia de todos sus docs

Un tenant con `graph: true` activa GraphRAG por override de organización (PATCH /settings) antes de subir el corpus.

Uso:  uv run python -m ragsis_eval.run --golden eval/golden/sample.yaml [--assert]
"""

from __future__ import annotations

import argparse
import json
import statistics
import sys
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path

import httpx
import yaml

CONTENT_TYPES = {".md": "text/markdown", ".txt": "text/plain", ".html": "text/html", ".pdf": "application/pdf",
                 ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                 ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
                 ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                 ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg"}
THRESHOLDS = {"answer_accuracy": 0.85, "evidence_hit_rate": 0.85, "citation_precision": 0.95,
              "abstention_precision": 0.90, "abstention_recall": 0.90, "acl_leakage": 0}


@dataclass
class Session:
    api: str
    token: str
    user_id: str = ""

    def req(self, method: str, path: str, **kw) -> httpx.Response:
        r = httpx.request(method, f"{self.api}/v1/{path}", headers={"authorization": f"Bearer {self.token}"},
                          timeout=90, **kw)
        if r.status_code >= 400:
            raise RuntimeError(f"{method} {path} -> {r.status_code}: {r.text[:300]}")
        return r


@dataclass
class TenantState:
    org: str
    ws: str
    users: dict[str, Session] = field(default_factory=dict)
    doc_titles: dict[str, str] = field(default_factory=dict)   # document_id -> título


def login(api: str, email: str) -> Session:
    r = httpx.post(f"{api}/v1/auth/dev-login", json={"email": email}, timeout=30)
    r.raise_for_status()
    s = Session(api, r.json()["token"])
    s.user_id = s.req("GET", "me").json()["user"]["id"]
    return s


def provision(api: str, key: str, spec: dict, corpus: Path, run_id: str) -> TenantState:
    """`run_id` vacío usa los correos y el nombre tal cual (semilla local: scripts/seed-dev.py)."""
    users_spec = spec["users"]
    tag = f"+{run_id}" if run_id else ""
    sessions = {name: login(api, u["email"].replace("@", f"{tag}@")) for name, u in users_spec.items()}
    owner = sessions["owner"]
    org = owner.req("POST", "organizations", json={"name": f"{spec['name']} {run_id}".strip()}).json()
    st = TenantState(org["id"], org["default_workspace_id"], sessions)
    if spec.get("graph"):
        owner.req("PATCH", f"organizations/{st.org}/settings", json={"graph_mode": "on"})
    groups = {}
    for g in spec.get("groups", []):
        groups[g] = owner.req("POST", f"organizations/{st.org}/groups", json={"name": g}).json()["id"]
    for name, u in users_spec.items():
        s = sessions[name]
        if name != "owner":
            owner.req("POST", f"organizations/{st.org}/members",
                      json={"email": u["email"].replace("@", f"{tag}@"), "role": u.get("role", "member")})
            owner.req("POST", f"organizations/{st.org}/workspaces/{st.ws}/members",
                      json={"user_id": s.user_id, "role": u.get("workspace_role", "reader")})
        for g in u.get("groups", []):
            owner.req("POST", f"organizations/{st.org}/groups/{groups[g]}/members", json={"user_id": s.user_id})
    pending = []
    for d in spec["documents"]:
        path = corpus / d["file"]
        data = path.read_bytes()
        acl = [f"group:{groups[g]}" for g in d.get("acl_groups", [])] or None
        body = {"workspace_id": st.ws, "filename": path.name, "content_type": CONTENT_TYPES[path.suffix],
                "size_bytes": len(data), "title": d["title"], **({"acl": acl} if acl else {})}
        up = owner.req("POST", f"organizations/{st.org}/documents/uploads", json=body).json()
        put = httpx.put(up["upload"]["url"], content=data, headers=up["upload"]["headers"], timeout=60)
        put.raise_for_status()
        owner.req("POST", f"organizations/{st.org}/documents/{up['document_id']}/versions/{up['version_id']}/complete")
        st.doc_titles[up["document_id"]] = d["title"]
        pending.append(up["document_id"])
    deadline = time.time() + 180
    while pending and time.time() < deadline:
        for doc in list(pending):
            v = owner.req("GET", f"organizations/{st.org}/documents/{doc}/status").json()["versions"][0]
            if v["status"] == "indexed":
                pending.remove(doc)
            elif v["status"] in ("failed", "rejected"):
                raise RuntimeError(f"ingesta fallida {st.doc_titles[doc]}: {v['error_code']}")
        time.sleep(1)
    if pending:
        raise RuntimeError(f"timeout de indexación en {key}: {pending}")
    return st


def evaluate(golden: dict, tenants: dict[str, TenantState]) -> dict:
    all_titles = {doc: title for t in tenants.values() for doc, title in t.doc_titles.items()}
    rows = []
    for q in golden["questions"]:
        t = tenants[q["tenant"]]
        s = t.users[q["user"]]
        t0 = time.perf_counter()
        res = s.req("POST", f"organizations/{t.org}/workspaces/{t.ws}/query", json={"question": q["question"]}).json()
        latency = (time.perf_counter() - t0) * 1000
        exp = q["expect"]
        answer = res["answer"]
        cited_titles = [all_titles.get(c["document_id"], "?") for c in res["citations"]]
        foreign = [c for c in res["citations"] if c["document_id"] not in t.doc_titles]
        leaked = bool(foreign) or any(m in answer or any(m in c.get("snippet", "") for c in res["citations"])
                                      for m in exp.get("must_not_contain", []))
        if q.get("acl_case") and not res["abstained"]:
            leaked = leaked or bool(res["citations"])
        docs = exp.get("docs") or ([exp["doc"]] if exp.get("doc") else [])
        rows.append({
            "id": q["id"], "tenant": q["tenant"], "user": q["user"], "answerable": exp["answerable"],
            "abstained": res["abstained"], "correct": exp["answerable"] and not res["abstained"]
            and all(c in answer for c in exp.get("contains", [])),
            "evidence_hit": exp["answerable"] and bool(docs) and all(d in cited_titles for d in docs),
            "citations": len(res["citations"]),
            "citations_ok": sum(1 for tt in cited_titles if tt in docs),
            "multi_hop": bool(q.get("multi_hop")),
            "leaked": leaked, "latency_ms": round(latency), "trace_id": res["trace_id"],
            "strategy": res.get("retrieval_strategy"), "answer": answer[:300],
        })
    ans = [r for r in rows if r["answerable"]]
    una = [r for r in rows if not r["answerable"]]
    abst = [r for r in rows if r["abstained"]]
    n_cit = sum(r["citations"] for r in ans)
    lat = sorted(r["latency_ms"] for r in rows)
    metrics = {
        "questions": len(rows),
        "answer_accuracy": round(sum(r["correct"] for r in ans) / max(len(ans), 1), 3),
        "evidence_hit_rate": round(sum(r["evidence_hit"] for r in ans) / max(len(ans), 1), 3),
        "citation_precision": round(sum(r["citations_ok"] for r in ans) / max(n_cit, 1), 3),
        "abstention_precision": round(sum(not r["answerable"] for r in abst) / max(len(abst), 1), 3),
        "abstention_recall": round(sum(r["abstained"] for r in una) / max(len(una), 1), 3),
        "acl_leakage": sum(r["leaked"] for r in rows),
        "multi_hop_accuracy": round(sum(r["correct"] and r["evidence_hit"] for r in ans if r["multi_hop"])
                                    / max(sum(1 for r in ans if r["multi_hop"]), 1), 3),
        "latency_p50_ms": int(statistics.median(lat)) if lat else 0,
        "latency_p95_ms": lat[min(len(lat) - 1, int(len(lat) * 0.95))] if lat else 0,
    }
    return {"metrics": metrics, "rows": rows}


def check(metrics: dict) -> list[str]:
    fails = []
    for k, v in THRESHOLDS.items():
        if k == "acl_leakage":
            if metrics[k] > v:
                fails.append(f"{k}={metrics[k]} (meta {v})")
        elif metrics[k] < v:
            fails.append(f"{k}={metrics[k]} < {v}")
    return fails


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--api", default="http://localhost:4000")
    ap.add_argument("--golden", default="eval/golden/sample.yaml")
    ap.add_argument("--corpus", default="eval/corpus")
    ap.add_argument("--out", default="eval/reports")
    ap.add_argument("--assert", dest="do_assert", action="store_true", help="falla si no se cumplen las metas")
    args = ap.parse_args()

    golden = yaml.safe_load(Path(args.golden).read_text(encoding="utf-8"))
    run_id = uuid.uuid4().hex[:8]
    print(f"run {run_id}: provisionando tenants y corpus…")
    tenants = {k: provision(args.api, k, spec, Path(args.corpus), run_id) for k, spec in golden["tenants"].items()}
    print("evaluando golden set…")
    report = evaluate(golden, tenants)
    report["run_id"] = run_id
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    (out / f"eval-{run_id}.json").write_text(json.dumps(report, ensure_ascii=False, indent=2))
    for r in report["rows"]:
        flag = "LEAK" if r["leaked"] else ("ok" if (r["correct"] if r["answerable"] else r["abstained"]) else "FAIL")
        print(f"  {r['id']} [{flag:4}] {r['tenant']}/{r['user']:7} abst={r['abstained']!s:5} cites={r['citations']} "
              f"{r['latency_ms']}ms  {r['answer'][:90]!r}")
    print(json.dumps(report["metrics"], indent=2))
    fails = check(report["metrics"])
    if fails:
        print("METAS NO CUMPLIDAS: " + "; ".join(fails))
        if args.do_assert:
            sys.exit(1)
    else:
        print("todas las metas del piloto cumplidas")


if __name__ == "__main__":
    main()
