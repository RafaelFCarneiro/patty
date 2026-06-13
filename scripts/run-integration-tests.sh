#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

MCP_URL="${MCP_URL:-http://127.0.0.1:3001/mcp}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:3001/api/health}"
STARTUP_TIMEOUT_SECONDS="${STARTUP_TIMEOUT_SECONDS:-60}"
DEV_LOG_FILE="${DEV_LOG_FILE:-/tmp/fintrack-integration-dev.log}"

started_db=0
started_backend=0
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

  if [[ "$started_backend" -eq 1 && -n "$backend_pid" ]]; then
    log "Stopping backend (pid $backend_pid)"
    kill "$backend_pid" >/dev/null 2>&1 || true
    wait "$backend_pid" >/dev/null 2>&1 || true
  fi

  if [[ "$started_db" -eq 1 ]]; then
    log 'Stopping Neo4j container started by this script'
    docker compose stop neo4j >/dev/null 2>&1 || true
  fi

  exit "$exit_code"
}

trap cleanup EXIT INT TERM

if docker compose ps --status running neo4j | grep -q neo4j; then
  log 'Neo4j already running; reusing existing container'
else
  log 'Starting Neo4j (docker compose up -d --wait neo4j)'
  npm run infra:up:db
  started_db=1
fi

if is_health_up; then
  log 'Backend already running; reusing existing process'
else
  log "Starting backend (npm run dev), logs at $DEV_LOG_FILE"
  npm run dev >"$DEV_LOG_FILE" 2>&1 &
  backend_pid="$!"
  started_backend=1
  wait_for_health
fi

log "Running integration tests against $MCP_URL"
MCP_URL="$MCP_URL" npm run test:integration:raw
log 'Integration tests completed successfully'
