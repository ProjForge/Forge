#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd)"
COMPOSE_FILE="$REPO_ROOT/packages/schema/compose.yaml"
COMPOSE_PROJECT="forge-pi5-acceptance-$$"
DATABASE_URL='postgresql://forge_test:forge_test_local_only@127.0.0.1:55432/forge_test'
OUTPUT_PATH="$REPO_ROOT/forge-pi5-acceptance-result.json"
PLAN_ONLY=0
SKIP_INSTALL=0
COMPOSE_STARTED=0
STATUS='FAIL'
STAGE='preflight'
STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
POSTGRES_VERSION='unavailable'
VECTOR_VERSION='unavailable'

usage() {
  printf '%s\n' 'Usage: test-forge-pi5.sh [--plan-only] [--skip-install] [--output PATH]'
}

while (($#)); do
  case "$1" in
    --plan-only) PLAN_ONLY=1 ;;
    --skip-install) SKIP_INSTALL=1 ;;
    --output)
      shift
      [[ $# -gt 0 ]] || { usage >&2; exit 2; }
      OUTPUT_PATH="$1"
      ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'Unknown argument: %s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

if ((PLAN_ONLY)); then
  cat <<'JSON'
{"safe":true,"platform":"linux-arm64","target":"Raspberry Pi 5 8GB","database":"disposable Docker PostgreSQL 14 + pgvector 0.8.2","hostDatabaseTouched":false,"checks":["toolchain","monorepo","schema restart/reconnect","Gateway continuity","MCP continuity","Workbench project portability HTTP"],"cleanup":"docker volume and container removal"}
JSON
  exit 0
fi

MODEL='unknown ARM64 host'
OS_NAME='unknown Linux'
KERNEL="$(uname -r)"
ARCH="$(uname -m)"
NODE_VERSION='unavailable'
NPM_VERSION='unavailable'
DOCKER_VERSION='unavailable'
SOURCE_COMMIT='unavailable'

write_result() {
  command -v node >/dev/null 2>&1 || return 1
  FORGE_PI_RESULT_STATUS="$STATUS" \
  FORGE_PI_RESULT_STAGE="$STAGE" \
  FORGE_PI_RESULT_STARTED_AT="$STARTED_AT" \
  FORGE_PI_RESULT_FINISHED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  FORGE_PI_RESULT_MODEL="$MODEL" \
  FORGE_PI_RESULT_OS="$OS_NAME" \
  FORGE_PI_RESULT_KERNEL="$KERNEL" \
  FORGE_PI_RESULT_ARCH="$ARCH" \
  FORGE_PI_RESULT_NODE="$NODE_VERSION" \
  FORGE_PI_RESULT_NPM="$NPM_VERSION" \
  FORGE_PI_RESULT_DOCKER="$DOCKER_VERSION" \
  FORGE_PI_RESULT_COMMIT="$SOURCE_COMMIT" \
  FORGE_PI_RESULT_POSTGRES="$POSTGRES_VERSION" \
  FORGE_PI_RESULT_VECTOR="$VECTOR_VERSION" \
    node "$SCRIPT_DIR/write-pi5-result.mjs" "$OUTPUT_PATH"
}

cleanup() {
  local exit_code=$?
  set +e
  if ((COMPOSE_STARTED)); then
    docker compose -p "$COMPOSE_PROJECT" -f "$COMPOSE_FILE" down -v --remove-orphans >/dev/null 2>&1
  fi
  local result_written=0
  write_result && result_written=1
  if [[ "$STATUS" == 'PASS' ]]; then
    printf '\nPASS: Raspberry Pi 5 acceptance completed.\n'
  else
    printf '\nFAIL: Raspberry Pi 5 acceptance stopped at stage: %s\n' "$STAGE" >&2
  fi
  if ((result_written)); then
    printf 'Result: %s\n' "$OUTPUT_PATH"
  else
    printf 'Result not written because Node.js is unavailable.\n' >&2
  fi
  exit "$exit_code"
}
trap cleanup EXIT

missing_tools=()
for tool in node npm git docker; do
  command -v "$tool" >/dev/null 2>&1 || missing_tools+=("$tool")
done
if ((${#missing_tools[@]})); then
  printf 'Missing required tools: %s\n' "${missing_tools[*]}" >&2
  exit 1
fi
docker compose version >/dev/null
docker info >/dev/null

[[ "$ARCH" == 'aarch64' || "$ARCH" == 'arm64' ]] || { printf 'Expected a 64-bit ARM host, found: %s\n' "$ARCH" >&2; exit 1; }
if [[ -r /proc/device-tree/model ]]; then
  MODEL="$(tr -d '\0' </proc/device-tree/model)"
fi
if [[ "$MODEL" != *'Raspberry Pi 5'* && "${FORGE_ALLOW_GENERIC_ARM64:-0}" != '1' ]]; then
  printf 'Expected Raspberry Pi 5 hardware, found: %s\n' "$MODEL" >&2
  printf 'Set FORGE_ALLOW_GENERIC_ARM64=1 only for an intentional generic ARM64 run.\n' >&2
  exit 1
fi
if [[ -r /etc/os-release ]]; then
  OS_NAME="$(awk -F= '$1=="PRETTY_NAME" {sub(/^"/, "", $2); sub(/"$/, "", $2); print $2}' /etc/os-release)"
fi

NODE_VERSION="$(node --version)"
NPM_VERSION="$(npm --version)"
DOCKER_VERSION="$(docker version --format '{{.Server.Version}}')"
NODE_MAJOR="${NODE_VERSION#v}"; NODE_MAJOR="${NODE_MAJOR%%.*}"
NPM_MAJOR="${NPM_VERSION%%.*}"
((NODE_MAJOR >= 20)) || { printf 'Node.js 20+ is required, found: %s\n' "$NODE_VERSION" >&2; exit 1; }
((NPM_MAJOR >= 10)) || { printf 'npm 10+ is required, found: %s\n' "$NPM_VERSION" >&2; exit 1; }

MEMORY_KIB="$(awk '/^MemTotal:/ {print $2}' /proc/meminfo)"
((MEMORY_KIB >= 6000000)) || { printf 'At least 6 GB RAM is required for this acceptance run.\n' >&2; exit 1; }
FREE_KIB="$(df -Pk "$REPO_ROOT" | awk 'NR==2 {print $4}')"
((FREE_KIB >= 8000000)) || { printf 'At least 8 GB free disk space is required.\n' >&2; exit 1; }
if command -v ss >/dev/null 2>&1 && ss -ltn | awk 'NR>1 {print $4}' | grep -Eq '(^|:)55432$'; then
  printf 'Port 55432 is already in use; no process was changed.\n' >&2
  exit 1
fi

cd "$REPO_ROOT"
SOURCE_COMMIT="$(git rev-parse HEAD)"
if ((SKIP_INSTALL == 0)); then
  STAGE='npm-ci'
  npm ci
fi

STAGE='monorepo-check'
npm run check

STAGE='postgres-start'
COMPOSE_STARTED=1
docker compose -p "$COMPOSE_PROJECT" -f "$COMPOSE_FILE" up -d --wait postgres
POSTGRES_VERSION="$(docker compose -p "$COMPOSE_PROJECT" -f "$COMPOSE_FILE" exec -T postgres psql -U forge_test -d forge_test -Atqc 'SHOW server_version')"
VECTOR_VERSION="$(docker compose -p "$COMPOSE_PROJECT" -f "$COMPOSE_FILE" exec -T postgres psql -U forge_test -d forge_test -Atqc "SELECT default_version FROM pg_available_extensions WHERE name = 'vector'")"
[[ "$VECTOR_VERSION" == '0.8.2' ]] || { printf 'Expected pgvector 0.8.2, found: %s\n' "$VECTOR_VERSION" >&2; exit 1; }

STAGE='schema-before-restart'
FORGE_TEST_DATABASE_URL="$DATABASE_URL" FORGE_TEST_RESET=1 node packages/schema/tests/schema.test.mjs --server-before-restart

STAGE='postgres-restart'
docker compose -p "$COMPOSE_PROJECT" -f "$COMPOSE_FILE" restart postgres
docker compose -p "$COMPOSE_PROJECT" -f "$COMPOSE_FILE" up -d --wait postgres

STAGE='schema-after-restart'
FORGE_TEST_DATABASE_URL="$DATABASE_URL" node packages/schema/tests/schema.test.mjs --server-after-restart
FORGE_TEST_DATABASE_URL="$DATABASE_URL" node packages/schema/tests/schema.test.mjs --server-after-reconnect

STAGE='gateway-continuity'
FORGE_DATABASE_URL="$DATABASE_URL" npm run test:integration -w forge-persistence-gateway

STAGE='mcp-continuity'
npm run build -w forge-persistence-gateway
FORGE_DATABASE_URL="$DATABASE_URL" npm run test:integration -w forge-mcp-server

STAGE='workbench-portability-http'
npm run build -w forge-workbench
FORGE_DATABASE_URL="$DATABASE_URL" node scripts/acceptance/test-project-portability-http.mjs

STATUS='PASS'
STAGE='complete'
