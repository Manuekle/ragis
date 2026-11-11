"""Semilla del entorno local (make seed): organización de prueba con usuarios y documentos de ejemplo.

Usa la API del stack levantado (make up, AUTH_MODE=dev: entra cualquier correo, sin clave) y el corpus sintético de
eval/corpus/acme. Es idempotente: si la organización ya existe, no vuelve a crear nada.

    uv run python scripts/seed-dev.py [--api http://localhost:4000] [--web http://localhost:3000]

Usuarios (solo desarrollo; no existen en AWS ni en Cognito):
  prueba@ragsis.test   propietario; ve todo, incluidos los documentos restringidos al grupo Socios
  lector@ragsis.test   miembro con rol de lector; NO ve los documentos del grupo Socios (para probar permisos)
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

import yaml
from ragsis_eval.run import login, provision

ORG_NAME = "ACME Demo (local)"
OWNER = "prueba@ragsis.test"
READER = "lector@ragsis.test"
QUESTIONS = [
    ("owner", "¿Cuál es el monto máximo de viáticos nacionales por día?"),
    ("owner", "¿Qué distribución de utilidades aprobó la junta de socios?"),
    ("reader", "¿Qué distribución de utilidades aprobó la junta de socios?"),
    ("owner", "¿Cuál es el margen operativo de la región Caribe?"),
    ("owner", "¿Cuál es la política de teletrabajo para empleados en Japón?"),
]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--api", default="http://localhost:4000")
    ap.add_argument("--web", default="http://localhost:3000")
    ap.add_argument("--golden", default="eval/golden/sample.yaml")
    ap.add_argument("--corpus", default="eval/corpus")
    args = ap.parse_args()

    owner = login(args.api, OWNER)
    existing = [o for o in owner.req("GET", "me").json()["organizations"] if o["name"] == ORG_NAME]
    if existing:
        org = existing[0]["id"]
        print(f"La organización «{ORG_NAME}» ya existe; no se crea de nuevo.")
        ws = owner.req("GET", f"organizations/{org}/workspaces").json()["workspaces"][0]["id"]
    else:
        spec = yaml.safe_load(Path(args.golden).read_text(encoding="utf-8"))["tenants"]["acme"]
        spec["name"] = ORG_NAME
        spec["users"]["owner"]["email"] = OWNER
        spec["users"]["analyst"]["email"] = READER
        print("Creando organización, usuarios y documentos (tarda unos segundos por la indexación)…")
        st = provision(args.api, "acme", spec, Path(args.corpus), run_id="")
        org, ws = st.org, st.ws
        print(f"Indexados {len(st.doc_titles)} documentos.")

    sessions = {"owner": owner, "reader": login(args.api, READER)}
    print("\nPrueba rápida de Ask:")
    ok = True
    for who, question in QUESTIONS:
        res = sessions[who].req("POST", f"organizations/{org}/workspaces/{ws}/query", json={"question": question}).json()
        state = "se abstiene" if res["abstained"] else f"{len(res['citations'])} cita(s)"
        print(f"  [{who:6}] {question}\n           → {state}: {res['answer'][:110]!r}")
        ok = ok and bool(res["answer"])

    print(f"\nEntra en {args.web}/login con {OWNER} (sin clave) y abre la organización «{ORG_NAME}».")
    print(f"Para probar permisos entra con {READER}: no debe ver el acta de la junta de socios.")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
