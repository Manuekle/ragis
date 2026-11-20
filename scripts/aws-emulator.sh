#!/usr/bin/env bash
# AWS Emulator (official local emulator of the AWS APIs, https://github.com/aws/aws-emulator) in Docker.
#
#   scripts/aws-emulator.sh build    # builds the image from infra/docker/aws-emulator/Dockerfile
#   scripts/aws-emulator.sh up       # starts it in the background (builds the image if missing) and waits for health
#   scripts/aws-emulator.sh down     # stops it (all emulated resources are lost: they live in memory)
#   scripts/aws-emulator.sh status   # health check
#   scripts/aws-emulator.sh logs     # follows the emulator log (JSON lines)
#   eval "$(scripts/aws-emulator.sh env)"   # points the AWS CLI / SDKs / Terraform in this shell at the emulator
#
# Optional variables:
#   EMULATOR_PORT       port on 127.0.0.1 (default: 9297). Must match on both sides; see docs/guides/aws-emulator.md
#   EMULATOR_REGION     region for CLI/SDK calls (default: us-east-2, the project's selected Region)
#   EMULATOR_TELEMETRY  on|off (default: off). The emulator sends anonymous usage data to AWS when on
#   EMULATOR_MEMORY     container memory limit (default: 2g). Over the limit the container dies with exit code 137
#   EMULATOR_IMAGE      image name (default: ragsis-aws-emulator)
#
# The emulator serves HTTPS with a self-signed certificate and requires SigV4 signatures with keys it generates on
# every start. It writes those keys, an SDK config file and ca.pem to ~/.aws/emulator/<port>/. `env` prints the
# variables that use them; static "test" credentials do not work.
set -euo pipefail

ACTION="${1:-status}"
PORT="${EMULATOR_PORT:-9297}"
REGION="${EMULATOR_REGION:-us-east-2}"
TELEMETRY="${EMULATOR_TELEMETRY:-off}"
MEMORY="${EMULATOR_MEMORY:-2g}"
IMAGE="${EMULATOR_IMAGE:-ragsis-aws-emulator}"
NAME="ragsis-aws-emulator-$PORT"
DIR="$HOME/.aws/emulator/$PORT"
ENDPOINT="https://127.0.0.1:$PORT"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

healthy() { [ -f "$DIR/ca.pem" ] && curl -fsS -m 3 --cacert "$DIR/ca.pem" "$ENDPOINT/__admin/health" >/dev/null 2>&1; }

build() { docker build -t "$IMAGE" "$ROOT/infra/docker/aws-emulator"; }

case "$ACTION" in
  build) build ;;
  up)
    if healthy; then echo "AWS Emulator already running at $ENDPOINT"; exit 0; fi
    docker image inspect "$IMAGE" >/dev/null 2>&1 || build
    mkdir -p "$HOME/.aws/emulator"
    docker rm -f "$NAME" >/dev/null 2>&1 || true
    # -e HOME keeps the paths it writes (config file, ca.pem) valid on the host too.
    # Port published on 127.0.0.1 only: the emulator does not evaluate IAM policies and must not be reachable from the network.
    docker run -d --rm --name "$NAME" --memory="$MEMORY" --memory-swap="$MEMORY" \
      -p "127.0.0.1:$PORT:$PORT" -e HOME="$HOME" -v "$HOME/.aws/emulator:$HOME/.aws/emulator" \
      "$IMAGE" -p "$PORT" --telemetry "$TELEMETRY" >/dev/null
    for _ in $(seq 60); do healthy && break; sleep 1; done
    if ! healthy; then
      echo "AWS Emulator did not become healthy. Last log lines:" >&2
      docker logs --tail 20 "$NAME" >&2 || true
      exit 1
    fi
    echo "AWS Emulator running at $ENDPOINT (telemetry $TELEMETRY). Point this shell at it with:"
    echo '  eval "$(scripts/aws-emulator.sh env)"'
    ;;
  down) docker stop "$NAME" >/dev/null 2>&1 && echo "AWS Emulator stopped." || echo "AWS Emulator was not running." ;;
  status)
    if healthy; then echo "AWS Emulator healthy at $ENDPOINT"; else echo "AWS Emulator not responding at $ENDPOINT" >&2; exit 1; fi
    ;;
  logs) docker logs -f --tail 100 "$NAME" ;;
  env)
    # Printed for eval. Removes real credentials so nothing signs with them (the emulator would reject the call,
    # and without AWS_ENDPOINT_URL the same credentials would reach real AWS).
    cat <<EOF
unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN AWS_PROFILE
export AWS_ENDPOINT_URL=$ENDPOINT
export AWS_SHARED_CREDENTIALS_FILE=$DIR/emulator_credentials
export AWS_CONFIG_FILE=$DIR/config
export AWS_CA_BUNDLE=$DIR/ca.pem
export AWS_EC2_METADATA_DISABLED=true
export AWS_DISABLE_HOST_PREFIX_INJECTION=true
export AWS_REGION=$REGION
export AWS_DEFAULT_REGION=$REGION
EOF
    ;;
  *) echo "Usage: $0 {build|up|down|status|logs|env}" >&2; exit 2 ;;
esac
