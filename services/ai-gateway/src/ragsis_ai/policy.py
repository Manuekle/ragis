"""Política de residencia y clasificación de datos (sección 08 del plan).

  public        -> cualquier modelo registrado.
  internal      -> Bedrock en región aprobada, o modelos locales.
  confidential  -> modelos locales, o modelo cloud explícitamente en allowlist del tenant.
  restricted    -> solo inferencia/embeddings locales; jamás llamadas a APIs externas.

Modelos que entrenan con el contenido enviado (`trains_on_data`, p. ej. Muse Contributor): solo si el despliegue lo
habilita (AI_ALLOW_TRAINING_MODELS=true) y nunca con datos confidential o restricted, ni con allowlist.
"""

from __future__ import annotations

from ragsis_core.settings import get_settings

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
    if model.trains_on_data:
        if not get_settings().ai_allow_training_models:
            return False, f"{model.model_id} entrena con el contenido: deshabilitado en este despliegue"
        if dc == DataClass.CONFIDENTIAL:
            return False, "datos confidenciales: no se envían a modelos que entrenan con el contenido"
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
