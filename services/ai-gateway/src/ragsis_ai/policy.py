"""Política de residencia y clasificación de datos (sección 08 del plan).

  public        -> cualquier modelo registrado.
  internal      -> Bedrock en región aprobada, o modelos locales.
  confidential  -> modelos locales, o modelo cloud explícitamente en allowlist del tenant.
  restricted    -> solo inferencia/embeddings locales; jamás llamadas a APIs externas.
"""

from __future__ import annotations

from .registry import CLOUD, ModelSpec
from .types import DataClass, TenantAIPolicy


class PolicyViolation(Exception):
    pass


def is_allowed(model: ModelSpec, policy: TenantAIPolicy) -> tuple[bool, str]:
    dc = DataClass(policy.data_class)
    if model.locality != CLOUD:
        return True, "local"
    if dc == DataClass.RESTRICTED:
        return False, "tenant restringido: solo modelos locales"
    if model.regions and not set(model.regions) & set(policy.approved_regions):
        return False, f"modelo {model.model_id} fuera de regiones aprobadas"
    if dc == DataClass.CONFIDENTIAL and model.model_id not in policy.model_allowlist:
        return False, "datos confidenciales: modelo cloud no está en allowlist del tenant"
    if policy.model_allowlist and dc == DataClass.INTERNAL and model.model_id not in policy.model_allowlist:
        return False, "modelo no incluido en allowlist explícita del tenant"
    return True, "ok"


def require_allowed(model: ModelSpec, policy: TenantAIPolicy) -> None:
    ok, reason = is_allowed(model, policy)
    if not ok:
        raise PolicyViolation(reason)
