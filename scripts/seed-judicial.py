"""Demo account for the judicial case (make seed-judicial): a law firm that only holds the D-16.857 file.

Same corpus as eval/golden/judicial.yaml: the real Sentencia C-217 de 2026 (PDF) plus fictional firm documents (DOCX,
XLSX, PPTX, TXT, HTML) built by eval/corpus/judicial/build_corpus.py. Uses the running stack's API (make up,
AUTH_MODE=dev: any email signs in, no password).

Besides the documents, it leaves every page of the app with something to show:
  - Setup: onboarding completed with the legal profile and "internal" data (only if it was not finished from the UI;
    an org already marked confidential stays so, since the API only tightens it).
  - Agents: five legal agents pointed at the space that holds the file, each with Spanish test cases; the ones that
    pass their sandbox test are published as 1.0.0 (a failed one stays as a draft, as it would in real life).
  - Workflows: three published workflows (answer with sign-off, review of filings, audit when there is evidence).
  - Inbox / Activity: runs started by the associate waiting for the partner's decision, some approved, one rejected,
    and one started by the partner that waits for the associate (and shows separation of duties).

Idempotent: the organization, agents and workflows are only created once, and runs use fixed Idempotency-Keys. Human
steps expire after 7 days; run with --fresh-runs to start a new batch of runs (new keys) when the inbox has emptied.

    uv run python scripts/seed-judicial.py [--api http://localhost:4000] [--web http://localhost:3000] [--fresh-runs]

Users (development only; they do not exist in AWS or Cognito):
  socia@ortizlozano.test     owner and partner; sees everything, including the confidential fee memo.
                             Functional roles: reviewer, approver, signatory, agent designer, knowledge manager.
  asociado@ortizlozano.test  member, reader of the file; does NOT see the fee memo (to show permissions).
                             Functional role: reviewer (decides on the runs the partner starts).
"""

from __future__ import annotations

import argparse
import sys
import time
from datetime import date
from pathlib import Path

import httpx
import yaml
from ragsis_eval.run import Session, login, provision

ORG_NAME = "Ortiz Lozano Abogados"
OWNER = "socia@ortizlozano.test"
READER = "asociado@ortizlozano.test"
QUESTIONS = [
    ("owner", "¿Qué decidió la Corte en la Sentencia C-217 de 2026?"),
    ("owner", "¿Cuál es el presupuesto aprobado para la nueva demanda del caso Parra Rosas?"),
    ("reader", "¿Cuál es el presupuesto aprobado para la nueva demanda del caso Parra Rosas?"),
    ("owner", "¿Quién es responsable de la nueva demanda y cuántas horas ha registrado en el caso?"),
]

ROLES = {
    OWNER: ["reviewer", "approver", "signatory", "agent_designer", "knowledge_manager"],
    READER: ["reviewer"],
}

# Template code -> Spanish name, purpose and sandbox tests (answerable from the judicial corpus).
AGENTS = {
    "searcher": (
        "Buscador del expediente",
        "Responde preguntas sobre el expediente D-16.857 con citas y dice cuándo no encuentra la respuesta.",
        [
            ("Decisión de la Corte", "¿Qué decidió la Corte Constitucional en la Sentencia C-217 de 2026?"),
            ("Informe al cliente", "¿Cuándo debe enviarse el primer informe trimestral al cliente?"),
        ],
    ),
    "contract_auditor": (
        "Auditor de escritos",
        "Revisa los escritos del caso frente a la sentencia y la estrategia aprobada; marca hallazgos con severidad y cita.",
        [
            (
                "Escrito de corrección",
                "¿Qué pretensiones formula el escrito de corrección de la demanda y en qué plazo pide reglamentarlas?",
            )
        ],
    ),
    "comparator": (
        "Comparador de versiones",
        "Compara la demanda, la sentencia y los escritos del caso por página o apartado.",
        [
            (
                "Demanda frente a sentencia",
                "Compara lo que pidió la demanda corregida con lo que decidió la Corte en la Sentencia C-217 de 2026.",
            )
        ],
    ),
    "reviewer": (
        "Revisor de borradores",
        "Propone comentarios y un borrador revisado sin tocar el original; una persona valida cada cambio.",
        [("Acta con el cliente", "Revisa el acta de reunión con el cliente y propone comentarios sobre los próximos pasos.")],
    ),
    "signature_coordinator": (
        "Coordinador de firmas",
        "Prepara las solicitudes de firma de documentos aprobados; siempre firma una persona.",
        [("Preparar firma", "Prepara el borrador de firma del escrito de corrección de la demanda.")],
    ),
}

# Template code -> Spanish name and description. Human steps get the longest allowed expiry so the demo inbox lasts.
WORKFLOWS = {
    "answer_with_approval": (
        "Respuesta al cliente con visto bueno",
        "El buscador redacta una respuesta citada y una persona con rol de aprobador da el visto bueno antes de enviarla.",
    ),
    "contract_review": (
        "Revisión de escritos del caso",
        "El auditor marca hallazgos, el revisor propone comentarios y una persona aprueba la versión exacta.",
    ),
    "audit_if_evidence": (
        "Auditoría con evidencia",
        "Solo pasa a revisión humana si el auditor encontró evidencia citada; si no, se cierra.",
    ),
}
EXPIRES_HOURS = 168

# (key, who starts it, workflow template, task, what the other side does: None = leave pending, or (who, decision, comment))
RUNS = [
    (
        "cliente-c217",
        "reader",
        "answer_with_approval",
        "Prepara una respuesta para el cliente: ¿qué decidió la Corte en la Sentencia C-217 de 2026"
        " y qué significa para el caso Parra Rosas?",
        None,
    ),
    (
        "revision-correccion",
        "reader",
        "contract_review",
        "Revisa el escrito de corrección de la demanda frente a lo que decidió la Corte en la Sentencia C-217 de 2026.",
        None,
    ),
    (
        "informe-trimestral",
        "reader",
        "answer_with_approval",
        "¿Cuándo debe enviarse el primer informe trimestral al cliente y qué debe incluir?",
        ("owner", "approve", "Correcto, enviar con el resumen de la sentencia."),
    ),
    (
        "auditoria-cronologia",
        "reader",
        "audit_if_evidence",
        "Audita la cronología del expediente: ¿quién es responsable de cada actuación y cuántas horas se han registrado?",
        ("owner", "approve", "Hallazgos revisados."),
    ),
    (
        "presupuesto-demanda",
        "reader",
        "answer_with_approval",
        "¿Cuál es el presupuesto aprobado para la nueva demanda del caso Parra Rosas?",
        ("owner", "reject", "No enviar: el presupuesto está en el memorando confidencial de honorarios, solo para socios."),
    ),
    (
        "estrategia-comite",
        "owner",
        "contract_review",
        "Revisa la estrategia después del fallo y señala los riesgos para la próxima revisión del comité de litigio.",
        None,
    ),
]
TERMINAL = {"COMPLETED", "FAILED", "CANCELLED"}


def complete_onboarding(owner: Session, org: str) -> None:
    """Legal profile for a fresh database. Agents and spaces are created below, so steps 6 and 7 are skipped."""
    base = f"organizations/{org}/onboarding"
    if owner.req("GET", base).json()["status"] == "COMPLETED":
        return
    steps = {
        1: {"country": "Colombia", "timezone": "America/Bogota"},
        2: {
            "sector_primary": "legal",
            "sector_secondary": ["consulting"],
            "team_size": "15-50",
            "language": "es-CO",
            "initial_area": "law",
        },
        3: {"goals": ["sign", "approve", "ask"]},
        4: {"doc_types": ["contracts", "spreadsheets", "scanned", "policies"]},
        # "internal", not "confidential": the corpus is a public ruling plus fictional files, and confidential data is never
        # sent to models that train on content (Meta Muse), which would leave the demo on the extractive local answerer.
        5: {"data_classification": "internal", "deployment_preference": "private_cloud", "llm_policy": "cloud_allowed"},
    }
    for n, data in steps.items():
        owner.req("PUT", f"{base}/steps/{n}", json={"action": "complete", "data": data})
    for n in (6, 7, 8):
        owner.req("PUT", f"{base}/steps/{n}", json={"action": "skip", "data": {}})
    owner.req("POST", f"{base}/complete")
    print("  Setup: onboarding completed (legal profile).")


def set_access(owner: Session, org: str) -> None:
    members = {m["email"]: m for m in owner.req("GET", f"organizations/{org}/functional-roles").json()["members"]}
    for email, roles in ROLES.items():
        m = members[email]
        if sorted(m["roles"]) != sorted(roles):
            owner.req("PUT", f"organizations/{org}/members/{m['id']}/functional-roles", json={"roles": roles})
    # The associate reads every space of the firm (including the ones onboarding creates). Agents run with the
    # permissions of whoever starts the workflow, so an agent that reads a space the associate can't open would stop.
    reader = members[READER]["id"]
    for w in owner.req("GET", f"organizations/{org}/workspaces").json()["workspaces"]:
        owner.req("POST", f"organizations/{org}/workspaces/{w['id']}/members", json={"user_id": reader, "role": "reader"})
    print(
        "  Roles: partner = reviewer, approver, signatory, agent designer, knowledge manager;"
        " associate = reviewer, reads every space."
    )


def ensure_agents(owner: Session, org: str, ws: str) -> None:
    base = f"organizations/{org}/agents"
    by_template = {a["template_code"]: a for a in owner.req("GET", base).json()["agents"]}
    for code, (name, purpose, tests) in AGENTS.items():
        a = by_template.get(code) or owner.req("POST", base, json={"template": code, "space_ids": [ws]}).json()
        detail = owner.req("GET", f"{base}/{a['id']}").json()
        if detail["active_version"]:
            print(f"  Agent «{detail['name']}»: already published ({detail['active_version']['version']}).")
            continue
        cfg = detail["draft"]
        cfg["name"], cfg["purpose"] = name, purpose
        # The file lives in the default space; spaces created in onboarding start empty.
        cfg["knowledge"]["space_ids"] = list(dict.fromkeys([ws, *cfg["knowledge"]["space_ids"]]))
        cfg["tests"] = [{"name": n, "input": q, "expect_citations": cfg["knowledge"]["require_citations"]} for n, q in tests]
        owner.req("PUT", f"{base}/{a['id']}/draft", json={"config": cfg})
        test = owner.req("POST", f"{base}/{a['id']}/test", json={}).json()
        if test["status"] != "passed":
            failed = [c["name"] for case in test["cases"] for c in case["checks"] if not c["ok"]]
            print(f"  Agent «{name}»: test failed ({', '.join(failed) or 'see Agents'}); left as a draft.")
            continue
        pub = owner.req(
            "POST",
            f"{base}/{a['id']}/publish",
            json={"bump": "major", "changelog": "Primera versión para el expediente D-16.857."},
        ).json()
        print(f"  Agent «{name}»: test passed, published {pub['version']}.")


def ensure_workflows(owner: Session, org: str) -> dict[str, str]:
    base = f"organizations/{org}/workflows"
    by_template = {}
    for w in owner.req("GET", base).json()["workflows"]:
        d = owner.req("GET", f"{base}/{w['id']}").json()
        by_template.setdefault(d["template_code"], d)
    ids = {}
    for code, (name, description) in WORKFLOWS.items():
        w = (
            by_template.get(code)
            or owner.req("GET", f"{base}/{owner.req('POST', base, json={'template': code, 'name': name}).json()['id']}").json()
        )
        ids[code] = w["id"]
        if w["status"] == "published":
            print(f"  Workflow «{w['name']}»: already published.")
            continue
        graph = w["draft"]
        for n in graph["nodes"]:
            if n["type"] in ("HUMAN_REVIEW", "APPROVAL_GATE"):
                n["expires_hours"] = EXPIRES_HOURS
        draft = owner.req(
            "PUT", f"{base}/{w['id']}/draft", json={"graph": graph, "name": name, "description": description}
        ).json()
        if not draft["validation"]["ok"]:
            print(f"  Workflow «{name}»: not published ({'; '.join(e['message'] for e in draft['validation']['errors'])}).")
            ids.pop(code)
            continue
        pub = owner.req(
            "POST", f"{base}/{w['id']}/publish", json={"bump": "major", "changelog": "Primera versión para el despacho."}
        ).json()
        print(f"  Workflow «{name}»: published {pub['version']}.")
    return ids


def wait_run(s: Session, org: str, run: str, timeout: float = 240) -> dict:
    end = time.time() + timeout
    while True:
        r = s.req("GET", f"organizations/{org}/runs/{run}").json()
        if r["state"] in TERMINAL or r["state"] == "WAITING_HUMAN" or time.time() > end:
            return r
        time.sleep(2)


def seed_runs(sessions: dict[str, Session], org: str, workflows: dict[str, str], batch: str) -> None:
    started = []
    for key, who, code, task, then in RUNS:
        if code not in workflows:
            continue
        s = sessions[who]
        r = httpx.post(
            f"{s.api}/v1/organizations/{org}/workflows/{workflows[code]}/runs",
            json={"task": task},
            timeout=60,
            headers={"authorization": f"Bearer {s.token}", "idempotency-key": f"seed-judicial-{batch}-{key}"},
        )
        if r.status_code >= 400:
            raise RuntimeError(f"start run {key} -> {r.status_code}: {r.text[:300]}")
        res = r.json()
        started.append((res["id"], who, then, task, res.get("replay")))
    print(f"  Runs: {len(started)} started; waiting for the agents (can take a minute)…")
    for run_id, who, then, task, replay in started:
        r = wait_run(sessions[who], org, run_id)
        pending = [a for a in r["approvals"] if a["status"] == "PENDING"]
        if then and pending and r["state"] == "WAITING_HUMAN":
            decider, decision, comment = then
            a = pending[0]
            sessions[decider].req(
                "POST",
                f"organizations/{org}/approvals/{a['id']}/decision",
                json={"decision": decision, "action_hash": a["action_hash"], "comment": comment},
            )
            r = wait_run(sessions[who], org, run_id)
        print(f"    [{r['state']:13}] {r['workflow_name']}: {task[:70]}{' (existing)' if replay else ''}")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--api", default="http://localhost:4000")
    ap.add_argument("--web", default="http://localhost:3000")
    ap.add_argument("--golden", default="eval/golden/judicial.yaml")
    ap.add_argument("--corpus", default="eval/corpus")
    ap.add_argument("--fresh-runs", action="store_true", help="start a new batch of runs (today's date in the keys)")
    args = ap.parse_args()

    owner = login(args.api, OWNER)
    existing = [o for o in owner.req("GET", "me").json()["organizations"] if o["name"] == ORG_NAME]
    if existing:
        org = existing[0]["id"]
        print(f"«{ORG_NAME}» already exists; documents are not uploaded again.")
        ws = owner.req("GET", f"organizations/{org}/workspaces").json()["workspaces"][0]["id"]
    else:
        spec = yaml.safe_load(Path(args.golden).read_text(encoding="utf-8"))["tenants"]["judicial"]
        spec["name"] = ORG_NAME
        spec["users"]["owner"]["email"] = OWNER
        spec["users"]["analyst"]["email"] = READER
        print("Creating the organization, users and documents (indexing takes a few seconds)…")
        st = provision(args.api, "judicial", spec, Path(args.corpus), run_id="")
        org, ws = st.org, st.ws
        print(f"Indexed {len(st.doc_titles)} documents.")

    sessions = {"owner": owner, "reader": login(args.api, READER)}
    print("\nSetting up agents, workflows and activity:")
    complete_onboarding(owner, org)
    set_access(owner, org)
    ensure_agents(owner, org, ws)
    workflows = ensure_workflows(owner, org)
    seed_runs(sessions, org, workflows, date.today().isoformat() if args.fresh_runs else "v1")

    print("\nQuick Ask check:")
    for who, question in QUESTIONS:
        res = sessions[who].req("POST", f"organizations/{org}/workspaces/{ws}/query", json={"question": question}).json()
        state = "abstains" if res["abstained"] else f"{len(res['citations'])} citation(s)"
        print(f"  [{who:6}] {question}\n           -> {state}: {res['answer'][:140]}")

    print(f"\nOpen {args.web} and sign in with {OWNER} (partner) or {READER} (associate).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
