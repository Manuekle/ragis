#!/usr/bin/env bash
# Ensayo de infraestructura AWS en Floci (emulador local, http://localhost:4566) ANTES de tocar AWS real.
#
#   scripts/aws-rehearsal.sh plan      # muestra qué se crearía
#   scripts/aws-rehearsal.sh apply     # crea los recursos en Floci
#   scripts/aws-rehearsal.sh output    # muestra los outputs (equivalente a `terraform output -json runtime`)
#   scripts/aws-rehearsal.sh destroy   # borra todo lo creado en Floci
#
# Variables opcionales:
#   REHEARSAL_ENV    entorno de infra/terraform/envs a ensayar (por defecto: pilot)
#   FLOCI_ENDPOINT   endpoint del emulador (por defecto: http://localhost:4566)
#   REHEARSAL_HOSTNAME  nombre DNS ficticio para el entorno pilot (por defecto: piloto.ragsis.test)
#   REHEARSAL_INSTANCE_TYPE  tipo de EC2 solo para el ensayo (por defecto: m5.large; Floci no conoce m7i-flex.large)
#   REHEARSAL_TARGETS   direcciones de Terraform separadas por espacio para ensayar solo una parte
#                       (por ejemplo "module.storage aws_cognito_user_pool.pilot")
#
# Cómo funciona: copia infra/terraform a infra/terraform/.floci, agrega un override del proveedor que apunta a Floci
# (credenciales falsas, sin validar cuenta) y guarda el estado aparte. No lee ni modifica el estado del entorno real.
set -euo pipefail

ACTION="${1:-plan}"
ENV_NAME="${REHEARSAL_ENV:-pilot}"
ENDPOINT="${FLOCI_ENDPOINT:-http://localhost:4566}"
HOSTNAME_FAKE="${REHEARSAL_HOSTNAME:-piloto.ragsis.test}"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TF_SRC="$ROOT/infra/terraform"
WORK="$TF_SRC/.floci"
STATE="$WORK/state/$ENV_NAME.tfstate"

command -v terraform >/dev/null || { echo "Falta terraform en el PATH." >&2; exit 1; }
[ -d "$TF_SRC/envs/$ENV_NAME" ] || { echo "No existe infra/terraform/envs/$ENV_NAME." >&2; exit 1; }

if ! curl -fsS -m 3 "$ENDPOINT/_floci/health" >/dev/null; then
  echo "Floci no responde en $ENDPOINT. Levántalo primero (ver docs/guides/floci.md)." >&2
  exit 1
fi

mkdir -p "$WORK/state" "$WORK/envs" "$WORK/modules"
# Se copia el código, nunca el estado ni los plugins del entorno real.
rsync -a --delete --exclude '.terraform' --exclude '*.tfstate*' --exclude 'providers_override.tf' \
  "$TF_SRC/envs/$ENV_NAME/" "$WORK/envs/$ENV_NAME/"
rsync -a --delete "$TF_SRC/modules/" "$WORK/modules/"

cat > "$WORK/envs/$ENV_NAME/providers_override.tf" <<HCL
# Generado por scripts/aws-rehearsal.sh. Solo existe en infra/terraform/.floci (ignorado por Git).
provider "aws" {
  region                      = "us-east-2"
  access_key                  = "test"
  secret_key                  = "test"
  allowed_account_ids         = []
  skip_credentials_validation = true
  skip_metadata_api_check     = true
  skip_requesting_account_id  = true
  s3_use_path_style           = true
}
HCL

# El catálogo de Floci no incluye todos los tipos de instancia (m7i-flex.large no está): se ensaya con uno de la misma
# forma (2 vCPU, 8 GiB). Solo cambia en el ensayo; AWS real usa el tipo de main.tf.
INSTANCE_TYPE="${REHEARSAL_INSTANCE_TYPE:-m5.large}"
rm -f "$WORK/envs/$ENV_NAME/instance_override.tf"
if grep -q 'resource "aws_instance" "pilot"' "$WORK/envs/$ENV_NAME/main.tf"; then
  cat > "$WORK/envs/$ENV_NAME/instance_override.tf" <<HCL
# Generado por scripts/aws-rehearsal.sh (solo en el ensayo).
resource "aws_instance" "pilot" {
  instance_type = "$INSTANCE_TYPE"
}
HCL
fi

export TF_DATA_DIR="$WORK/data/$ENV_NAME"
export AWS_ENDPOINT_URL="$ENDPOINT"
export AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test AWS_DEFAULT_REGION=us-east-2
unset AWS_PROFILE AWS_SESSION_TOKEN

TF=(terraform -chdir="$WORK/envs/$ENV_NAME")
VARS=(-var "aws_account_id=000000000000" -var "pilot_hostname=$HOSTNAME_FAKE" -state="$STATE")
for addr in ${REHEARSAL_TARGETS:-}; do VARS+=(-target "$addr"); done

"${TF[@]}" init -input=false -upgrade=false >/dev/null

case "$ACTION" in
  plan)    "${TF[@]}" plan -input=false "${VARS[@]}" ;;
  apply)   "${TF[@]}" apply -input=false -auto-approve "${VARS[@]}" ;;
  destroy) "${TF[@]}" destroy -input=false -auto-approve "${VARS[@]}" ;;
  output)  "${TF[@]}" output -state="$STATE" -json ;;
  *) echo "Uso: $0 {plan|apply|output|destroy}" >&2; exit 2 ;;
esac
