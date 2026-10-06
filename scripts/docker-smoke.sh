#!/usr/bin/env bash
# Smoke-test a built FinTrack image the way compose.yaml runs it: key as a mounted file, read-only
# root + tmpfs /tmp, /data on a volume, published on host loopback only (ADR-032).
# Usage: scripts/docker-smoke.sh [image]   (default: fintrack:ci)
set -euo pipefail

IMAGE="${1:-fintrack:ci}"
SUFFIX="$$"
NAME="fintrack-smoke-$SUFFIX"
VOLUME="fintrack-smoke-data-$SUFFIX"
WORKDIR="$(mktemp -d)"
KEY_FILE="$WORKDIR/fintrack_db_key"

cleanup() {
  docker rm -f "$NAME" "$NAME-nokey" >/dev/null 2>&1 || true
  docker volume rm "$VOLUME" >/dev/null 2>&1 || true
  rm -rf "$WORKDIR"
}
trap cleanup EXIT

fail() { echo "FAIL: $*" >&2; docker logs "$NAME" >&2 2>&1 || true; exit 1; }

# Throwaway key; world-readable so the container's unprivileged user can read it (any host uid).
openssl rand -hex 32 > "$KEY_FILE"
chmod 0444 "$KEY_FILE"
KEY_VALUE="$(cat "$KEY_FILE")"

run_container() {
  docker run -d --name "$NAME" \
    -p 127.0.0.1::51737 \
    -v "$VOLUME":/data \
    -v "$KEY_FILE":/run/secrets/fintrack_db_key:ro \
    -e FINTRACK_DB_KEY_FILE=/run/secrets/fintrack_db_key \
    --read-only --tmpfs /tmp \
    --cap-drop ALL --security-opt no-new-privileges:true \
    "$IMAGE" >/dev/null
}

wait_healthy() {
  for _ in $(seq 1 60); do
    case "$(docker inspect -f '{{.State.Health.Status}}' "$NAME")" in
      healthy) return 0 ;;
      unhealthy) fail "container reported unhealthy" ;;
    esac
    [ "$(docker inspect -f '{{.State.Running}}' "$NAME")" = "true" ] || fail "container exited during startup"
    sleep 2
  done
  fail "container never became healthy"
}

base_url() { echo "http://127.0.0.1:$(docker port "$NAME" 51737/tcp | head -n1 | awk -F: '{print $NF}')"; }

http_code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

echo "== start (read-only root, key from file)"
run_container
wait_healthy
BASE="$(base_url)"

echo "== running as non-root"
[ "$(docker exec "$NAME" id -u)" != "0" ] || fail "container runs as root"

echo "== GET /api/status and /ui"
[ "$(http_code "$BASE/api/status")" = "200" ] || fail "/api/status not 200"
curl -fsS "$BASE/api/status" | grep -q '"db":"ok"' || fail "/api/status does not report db ok"
[ "$(http_code "$BASE/ui")" = "200" ] || fail "/ui not 200"

echo "== POST /mcp initialize"
INIT='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}'
curl -fsS -X POST "$BASE/mcp" \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d "$INIT" | grep -q '"result"' || fail "/mcp initialize returned no JSON-RPC result"

echo "== create an account"
[ "$(http_code -X POST "$BASE/api/accounts" -H 'Content-Type: application/json' -d '{"name":"Smoke"}')" = "201" ] \
  || fail "account creation not 201"

echo "== restart and check persistence"
docker restart "$NAME" >/dev/null
wait_healthy
BASE="$(base_url)"
curl -fsS "$BASE/api/accounts" | grep -q '"Smoke"' || fail "account did not survive restart"

echo "== only /data is writable"
# /var/tmp is writable by `node` on a normal root filesystem, so this only fails under --read-only.
if docker exec "$NAME" sh -c 'touch /var/tmp/probe 2>/dev/null'; then fail "root filesystem is writable"; fi
docker exec "$NAME" sh -c 'touch /data/.probe && rm /data/.probe' || fail "/data is not writable"

echo "== key never leaks into logs, env or volume"
if docker logs "$NAME" 2>&1 | grep -q "$KEY_VALUE"; then fail "key found in container logs"; fi
if docker inspect "$NAME" | grep -q "$KEY_VALUE"; then fail "key found in container config"; fi
if docker run --rm -v "$VOLUME":/data --entrypoint grep "$IMAGE" -rqF "$KEY_VALUE" /data; then fail "key found on the data volume"; fi

echo "== no key source: fails fast with the openssl hint"
set +e
NOKEY_OUT="$(docker run --rm --name "$NAME-nokey" --read-only --tmpfs /tmp "$IMAGE" 2>&1)"
NOKEY_CODE=$?
set -e
[ "$NOKEY_CODE" -ne 0 ] || fail "container started without a key source"
echo "$NOKEY_OUT" | grep -q "openssl rand -hex 32" || { echo "$NOKEY_OUT" >&2; fail "missing openssl hint in logs"; }

echo "smoke OK"
