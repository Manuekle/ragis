#!/usr/bin/env bash
# Ensayo de infraestructura AWS en AWS Emulator (emulador oficial de AWS, https://127.0.0.1:9297) ANTES de tocar AWS real.
#
#   scripts/aws-emulator.sh up         # primero: levanta el emulador (Docker)
#   scripts/aws-rehearsal.sh plan      # muestra qué se crearía
#   scripts/aws-rehearsal.sh apply     # crea los recursos en el emulador
#   scripts/aws-rehearsal.sh output    # muestra los outputs (equivalente a `terraform output -json runtime`)
#   scripts/aws-rehearsal.sh destroy   # borra todo lo creado en el emulador
#
# Variables opcionales:
#   REHEARSAL_ENV    entorno de infra/terraform/envs a ensayar (por defecto: pilot)
#   EMULATOR_PORT    puerto del emulador en 127.0.0.1 (por defecto: 9297)
#   REHEARSAL_HOSTNAME  nombre DNS ficticio para el entorno pilot (por defecto: piloto.ragsis.test)
#   REHEARSAL_INSTANCE_TYPE  tipo de EC2 solo para el ensayo (por defecto: el de main.tf; el emulador conoce m7i-flex.large)
#   REHEARSAL_TARGETS   direcciones de Terraform separadas por espacio para ensayar solo una parte
#                       (por ejemplo "module.storage aws_cognito_user_pool.pilot")
#
# Cómo funciona: copia infra/terraform a infra/terraform/.emulator, agrega un override del proveedor (región fija, cuenta
# ficticia) y guarda el estado aparte. El endpoint, las claves generadas por el emulador y su certificado llegan por las
# variables de `scripts/aws-emulator.sh env`. No lee ni modifica el estado del entorno real.
set -euo pipefail

ACTION="${1:-plan}"
ENV_NAME="${REHEARSAL_ENV:-pilot}"
HOSTNAME_FAKE="${REHEARSAL_HOSTNAME:-piloto.ragsis.test}"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TF_SRC="$ROOT/infra/terraform"
WORK="$TF_SRC/.emulator"
STATE="$WORK/state/$ENV_NAME.tfstate"

command -v terraform >/dev/null || { echo "Falta terraform en el PATH." >&2; exit 1; }
[ -d "$TF_SRC/envs/$ENV_NAME" ] || { echo "No existe infra/terraform/envs/$ENV_NAME." >&2; exit 1; }

if ! "$ROOT/scripts/aws-emulator.sh" status >/dev/null 2>&1; then
  echo "AWS Emulator no responde. Levántalo primero: scripts/aws-emulator.sh up (ver docs/guides/aws-emulator.md)." >&2
  exit 1
fi

mkdir -p "$WORK/state" "$WORK/envs" "$WORK/modules"
# Se copia el código, nunca el estado ni los plugins del entorno real.
rsync -a --delete --exclude '.terraform' --exclude '*.tfstate*' --exclude 'providers_override.tf' \
  "$TF_SRC/envs/$ENV_NAME/" "$WORK/envs/$ENV_NAME/"
rsync -a --delete "$TF_SRC/modules/" "$WORK/modules/"

cat > "$WORK/envs/$ENV_NAME/providers_override.tf" <<HCL
# Generado por scripts/aws-rehearsal.sh. Solo existe en infra/terraform/.emulator (ignorado por Git).
# Credenciales, endpoint y certificado: AWS_SHARED_CREDENTIALS_FILE, AWS_ENDPOINT_URL y AWS_CA_BUNDLE del emulador.
provider "aws" {
  region                  = "us-east-2"
  allowed_account_ids     = ["000000000000"]
  skip_metadata_api_check = true
  s3_use_path_style       = true
  # S3 Control (tags de buckets en el provider 6.x) pone el ID de cuenta delante del host: 000000000000.127.0.0.1 no
  # existe, 000000000000.localhost sí resuelve a loopback. El certificado del emulador no cubre *.localhost, por eso
  # insecure: solo en este ensayo, contra el emulador local con claves temporales.
  insecure = true
  endpoints {
    s3control = "https://localhost:${EMULATOR_PORT:-9297}"
  }
}
HCL

# Opcional: otro tipo de EC2 solo en el ensayo (AWS real usa el de main.tf).
rm -f "$WORK/envs/$ENV_NAME/instance_override.tf"
if [ -n "${REHEARSAL_INSTANCE_TYPE:-}" ] && grep -q 'resource "aws_instance" "pilot"' "$WORK/envs/$ENV_NAME/main.tf"; then
  cat > "$WORK/envs/$ENV_NAME/instance_override.tf" <<HCL
# Generado por scripts/aws-rehearsal.sh (solo en el ensayo).
resource "aws_instance" "pilot" {
  instance_type = "$REHEARSAL_INSTANCE_TYPE"
}
HCL
fi

# El emulador no trae los parámetros SSM públicos de Canonical (/aws/service/canonical/...), y como AWS no deja crear
# nombres con prefijo "aws". En el ensayo la AMI sale del parámetro público de Amazon Linux 2023, que sí existe.
# AWS real usa Ubuntu como dice main.tf.
rm -f "$WORK/envs/$ENV_NAME/ami_override.tf"
if grep -q 'data "aws_ssm_parameter" "ubuntu"' "$WORK/envs/$ENV_NAME/main.tf"; then
  cat > "$WORK/envs/$ENV_NAME/ami_override.tf" <<HCL
# Generado por scripts/aws-rehearsal.sh (solo en el ensayo).
data "aws_ssm_parameter" "ubuntu" {
  name = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64"
}
HCL
fi

# RunInstances con especificación de interfaz de red (lo que manda el provider con associate_public_ip_address) no está
# implementado en el emulador. En el ensayo se omite; en AWS real la IP pública la da la Elastic IP igualmente.
rm -f "$WORK/envs/$ENV_NAME/network_override.tf" "$WORK/envs/$ENV_NAME/rehearsal_subnet.tf"
if grep -q 'resource "aws_instance" "pilot"' "$WORK/envs/$ENV_NAME/main.tf"; then
  cat > "$WORK/envs/$ENV_NAME/network_override.tf" <<HCL
# Generado por scripts/aws-rehearsal.sh (solo en el ensayo).
resource "aws_instance" "pilot" {
  associate_public_ip_address = null
  availability_zone           = data.aws_subnet.rehearsal.availability_zone
}
HCL
  # El provider manda Placement.AvailabilityZone vacío; AWS lo ignora, el emulador lo rechaza. Se fija la AZ de la subred.
  cat > "$WORK/envs/$ENV_NAME/rehearsal_subnet.tf" <<HCL
# Generado por scripts/aws-rehearsal.sh (solo en el ensayo).
data "aws_subnet" "rehearsal" {
  id = sort(data.aws_subnets.default.ids)[0]
}
HCL
fi

export TF_DATA_DIR="$WORK/data/$ENV_NAME"
# Endpoint, claves y certificado del emulador; quita credenciales reales del entorno.
eval "$("$ROOT/scripts/aws-emulator.sh" env)"

TF=(terraform -chdir="$WORK/envs/$ENV_NAME")
BASE_VARS=(-var "aws_account_id=000000000000" -var "pilot_hostname=$HOSTNAME_FAKE" -state="$STATE")
VARS=("${BASE_VARS[@]}")
for addr in ${REHEARSAL_TARGETS:-}; do VARS+=(-target "$addr"); done

"${TF[@]}" init -input=false -upgrade=false >/dev/null

# AWS Emulator 1.0.322 no implementa EC2 DescribeTags, que el provider llama al leer una instancia: la EC2 se lanza pero
# Terraform no puede leerla de vuelta. Por defecto el ensayo deja fuera la instancia y su Elastic IP (Terraform no tiene
# -exclude: se calculan los -target del resto). REHEARSAL_EXCLUDE="" ensaya todo, para probar versiones nuevas.
EXCLUDE="${REHEARSAL_EXCLUDE-aws_instance.pilot aws_eip.pilot}"
if [ -z "${REHEARSAL_TARGETS:-}" ] && [ -n "$EXCLUDE" ] && [ "$ACTION" != output ]; then
  if [ "$ACTION" = destroy ]; then
    addrs="$("${TF[@]}" state list -state="$STATE" 2>/dev/null | grep -v '^data\.' || true)"
  else
    plan_file="$WORK/data/$ENV_NAME/addresses.tfplan"
    "${TF[@]}" plan -input=false -refresh=false -out="$plan_file" "${VARS[@]}" >/dev/null
    addrs="$("${TF[@]}" show -json "$plan_file" | python3 -c '
import json, sys
plan = json.load(sys.stdin)
for change in plan.get("resource_changes", []):
    if change["mode"] == "managed":
        print(change["address"])')"
    rm -f "$plan_file"
  fi
  while IFS= read -r addr; do
    [ -n "$addr" ] || continue
    skip=false
    for ex in $EXCLUDE; do [ "$addr" = "$ex" ] && skip=true; done
    $skip || VARS+=(-target "$addr")
  done <<< "$addrs"
  echo "Ensayo sin: $EXCLUDE (EC2 DescribeTags no está implementado en el emulador; ver docs/guides/aws-emulator.md)" >&2
fi

case "$ACTION" in
  plan)    "${TF[@]}" plan -input=false "${VARS[@]}" ;;
  apply)
    # Al crear un security group, Terraform revoca la regla de salida "todo permitido" que AWS agrega por defecto. El
    # emulador no la reconoce cuando llega con FromPort=0/ToPort=0 y protocolo -1 (AWS ignora los puertos) y la deja;
    # luego aws_vpc_security_group_egress_rule falla con InvalidPermission.Duplicate. Se crea primero el SG y se
    # revoca a mano esa regla por defecto antes del apply completo. Solo la primera vez (SG aún no en el estado).
    if [ -z "${REHEARSAL_TARGETS:-}" ] && grep -q 'resource "aws_security_group" "web"' "$WORK/envs/$ENV_NAME/main.tf" \
       && ! "${TF[@]}" state list -state="$STATE" 2>/dev/null | grep -qx 'aws_security_group.web'; then
      "${TF[@]}" apply -input=false -auto-approve "${BASE_VARS[@]}" -target aws_security_group.web >/dev/null
      sg_id="$(python3 -c 'import json,sys; s=json.load(open(sys.argv[1])); print(next(r["instances"][0]["attributes"]["id"] for r in s["resources"] if r["mode"]=="managed" and r["type"]=="aws_security_group" and r["name"]=="web"))' "$STATE")"
      aws ec2 revoke-security-group-egress --group-id "$sg_id" \
        --ip-permissions '[{"IpProtocol":"-1","IpRanges":[{"CidrIp":"0.0.0.0/0"}]}]' >/dev/null 2>&1 || true
    fi
    "${TF[@]}" apply -input=false -auto-approve "${VARS[@]}" ;;
  destroy) "${TF[@]}" destroy -input=false -auto-approve "${VARS[@]}" ;;
  output)  "${TF[@]}" output -state="$STATE" -json ;;
  *) echo "Uso: $0 {plan|apply|output|destroy}" >&2; exit 2 ;;
esac
