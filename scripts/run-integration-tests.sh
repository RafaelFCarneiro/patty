#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

TEST_NEO4J_URI="${TEST_NEO4J_URI:-bolt://127.0.0.1:7688}"
MCP_URL="${MCP_URL:-http://127.0.0.1:3001/mcp}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:3001/api/health}"
STARTUP_TIMEOUT_SECONDS="${STARTUP_TIMEOUT_SECONDS:-60}"
DEV_LOG_FILE="${DEV_LOG_FILE:-/tmp/fintrack-integration-dev.log}"

COMPOSE="docker compose -f docker-compose.yml -f docker-compose.test.yml"

backend_pid=""

log() {
  printf '[integration-runner] %s\n' "$1"
}

is_health_up() {
  curl -fsS "$HEALTH_URL" >/dev/null 2>&1
}

wait_for_health() {
  local deadline=$((SECONDS + STARTUP_TIMEOUT_SECONDS))
  while (( SECONDS < deadline )); do
    if is_health_up; then
      return 0
    fi
    sleep 1
  done

  log "Backend did not become healthy within ${STARTUP_TIMEOUT_SECONDS}s"
  if [[ -f "$DEV_LOG_FILE" ]]; then
    log "Last backend logs:"
    tail -n 60 "$DEV_LOG_FILE" || true
  fi
  return 1
}

cleanup() {
  local exit_code=$?

  if [[ -n "$backend_pid" ]]; then
    log "Stopping backend (pid $backend_pid)"
    kill "$backend_pid" >/dev/null 2>&1 || true
    wait "$backend_pid" >/dev/null 2>&1 || true
  fi

  log "Tearing down test Neo4j container and wiping volume"
  $COMPOSE down --volumes neo4j >/dev/null 2>&1 || true

  exit "$exit_code"
}

trap cleanup EXIT INT TERM

log "Starting isolated test Neo4j on bolt port 7688"
$COMPOSE up -d --wait neo4j

log "Starting backend pointed at test DB (logs at $DEV_LOG_FILE)"
NEO4J_URI="$TEST_NEO4J_URI" npm run dev >"$DEV_LOG_FILE" 2>&1 &
backend_pid="$!"
wait_for_health

log "Running integration tests against $MCP_URL"
MCP_URL="$MCP_URL" npm run test:integration:raw
log "Integration tests completed successfully"
