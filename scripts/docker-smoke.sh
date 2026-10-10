#!/usr/bin/env bash
# Smoke-test a built FinTrack image the way compose.yaml runs it: key as a mounted file, read-only
# root + tmpfs /tmp, /data on a volume, published on host loopback only (ADR-032), with sessions required
# (ADR-033): the setup code is read from the container log and claims the owner, and personal access tokens
# (created through the session) authenticate /api and /mcp.
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

SMOKE_USER="smoke"
SMOKE_PASSWORD="$(openssl rand -hex 16)"   # 32 chars; throwaway
SETUP_CODE_PATTERN='[0-9A-Z]{4}(-[0-9A-Z]{4}){4}'
SETUP_BANNER_PATTERN='first-time setup'
COOKIE_JAR="$WORKDIR/cookies"

# curl as a browser at the loopback publish would: the matching Origin, and the session cookie once we have one.
authed() { curl -sS -b "$COOKIE_JAR" -H "Origin: $BASE" "$@"; }
authed_code() { authed -o /dev/null -w '%{http_code}' "$@"; }
setup_banner_count() { docker logs "$NAME" 2>&1 | grep -c "$SETUP_BANNER_PATTERN" || true; }

echo "== unauthenticated: only /api/health is open; everything else needs a session (ADR-033 §6)"
curl -fsS "$BASE/api/health" | grep '"db":"ok"' >/dev/null || fail "/api/health does not report db ok"
[ "$(http_code "$BASE/api/status")" = "401" ] || fail "/api/status reachable without a session"
[ "$(http_code "$BASE/api/accounts")" = "401" ] || fail "/api/accounts reachable without a session"
INIT='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}'
[ "$(http_code -X POST "$BASE/mcp" -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -d "$INIT")" = "401" ] \
  || fail "/mcp reachable without a session"
[ "$(http_code "$BASE/ui")" = "303" ] || fail "/ui should redirect an unauthenticated browser"

echo "== the first start printed a setup code to the log (stderr), once"
SETUP_CODE="$(docker logs "$NAME" 2>&1 | grep -oE "$SETUP_CODE_PATTERN" | head -n1 || true)"
[ -n "$SETUP_CODE" ] || fail "no setup code in the container log"
[ "$(setup_banner_count)" = "1" ] || fail "expected exactly one setup banner in the log"

echo "== POST /ui/setup claims the owner and starts a session"
SETUP_STATUS="$(curl -sS -o /dev/null -w '%{http_code}' -c "$COOKIE_JAR" -H "Origin: $BASE" -X POST "$BASE/ui/setup" \
  --data-urlencode "code=$SETUP_CODE" --data-urlencode "username=$SMOKE_USER" --data-urlencode "password=$SMOKE_PASSWORD")"
[ "$SETUP_STATUS" = "303" ] || fail "/ui/setup returned $SETUP_STATUS, expected 303"
SESSION_TOKEN="$(awk '$6=="fintrack_session"{print $7}' "$COOKIE_JAR")"
[ -n "$SESSION_TOKEN" ] || fail "setup set no session cookie"

echo "== with the session cookie and a matching Origin: /api/status, /ui and /mcp work"
[ "$(authed_code "$BASE/api/status")" = "200" ] || fail "/api/status not 200 with a session"
authed -fS "$BASE/api/status" | grep '"db":"ok"' >/dev/null || fail "/api/status does not report db ok"
[ "$(authed_code "$BASE/ui")" = "200" ] || fail "/ui not 200 with a session"
authed -fS -X POST "$BASE/mcp" \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d "$INIT" | grep '"result"' >/dev/null || fail "/mcp initialize returned no JSON-RPC result"

echo "== CSRF: a cross-origin unsafe request carrying the cookie is refused"
[ "$(curl -sS -o /dev/null -w '%{http_code}' -b "$COOKIE_JAR" -H 'Origin: https://evil.example' \
  -X POST "$BASE/api/accounts" -H 'Content-Type: application/json' -d '{"name":"Evil"}')" = "403" ] \
  || fail "cross-origin POST was not refused"

echo "== create an account"
[ "$(authed_code -X POST "$BASE/api/accounts" -H 'Content-Type: application/json' -d '{"name":"Smoke"}')" = "201" ] \
  || fail "account creation not 201"

echo "== personal access tokens: minted through the session, shown once, usable as a bearer on /api and /mcp"
TOKEN_PATTERN='ftk_[A-Za-z0-9_-]{43}'
mint_token() { # name, access (read|write) -> prints the plaintext token
  authed -fsS -X POST "$BASE/ui/access/tokens" \
    --data-urlencode "password=$SMOKE_PASSWORD" --data-urlencode "name=$1" --data-urlencode "access=$2" --data-urlencode "expiry=30" | grep -oE "$TOKEN_PATTERN" | head -n1
}
WRITE_TOKEN="$(mint_token smoke-writer write)"
READ_TOKEN="$(mint_token smoke-reader read)"
[ -n "$WRITE_TOKEN" ] && [ -n "$READ_TOKEN" ] && [ "$WRITE_TOKEN" != "$READ_TOKEN" ] || fail "could not mint tokens"
authed -fsS "$BASE/ui/access/tokens" | grep -F "$READ_TOKEN" >/dev/null && fail "the token plaintext is listed after creation"
READER_ID="$(authed -fsS "$BASE/ui/access/tokens" | grep -oE '/ui/access/tokens/[0-9a-f-]{36}/revoke' | head -n1 | cut -d/ -f5)"
[ -n "$READER_ID" ] || fail "no revoke link for the newest token"

HEADERS_FILE="$WORKDIR/headers"
MCP_JSON=(-H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream')
# A bearer request carries no cookie and no Origin: the token is the only credential.
mcp_status() { # token, json body -> HTTP status; response headers in $HEADERS_FILE, body in $WORKDIR/body
  curl -sS -o "$WORKDIR/body" -D "$HEADERS_FILE" -w '%{http_code}' -X POST "$BASE/mcp" "${MCP_JSON[@]}" \
    -H "Authorization: Bearer $1" -d "$2"
}
CALL_LIST='{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"list_accounts","arguments":{}}}'
CALL_CREATE='{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"create_account","arguments":{"name":"ViaMcp","type":"checking","currency":"USD"}}}'

[ "$(mcp_status "$READ_TOKEN" "$INIT")" = "200" ] && grep '"result"' "$WORKDIR/body" >/dev/null || fail "/mcp initialize with a read token failed"
[ "$(mcp_status "$READ_TOKEN" "$CALL_LIST")" = "200" ] && grep -F 'Smoke' "$WORKDIR/body" >/dev/null || fail "a read tool with a read token failed"
[ "$(mcp_status "$READ_TOKEN" "$CALL_CREATE")" = "403" ] || fail "a write tool with a read token was not 403"
grep -i '^www-authenticate:.*error="insufficient_scope".*scope="fintrack:write"' "$HEADERS_FILE" >/dev/null \
  || fail "403 lacks the insufficient_scope challenge"
[ "$(mcp_status "$WRITE_TOKEN" "$CALL_CREATE")" = "200" ] || fail "a write tool with a write token failed"
authed -fsS "$BASE/api/accounts" | grep '"ViaMcp"' >/dev/null || fail "the write token's account is missing"
[ "$(http_code -H "Authorization: Bearer $READ_TOKEN" "$BASE/api/accounts")" = "200" ] || fail "REST GET with a read token not 200"
[ "$(http_code -X POST -H "Authorization: Bearer $READ_TOKEN" -H 'Content-Type: application/json' -d '{"name":"No"}' "$BASE/api/accounts")" = "403" ] \
  || fail "REST POST with a read token was not 403"
[ "$(http_code -H "Authorization: Bearer $READ_TOKEN" "$BASE/ui/access/tokens")" = "303" ] || fail "a bearer token reached /ui/access/tokens"
[ "$(authed_code -X POST "$BASE/ui/access/tokens" --data-urlencode "password=wrong wrong wrong" --data-urlencode "name=x" --data-urlencode "access=write" --data-urlencode "expiry=30")" = "403" ] \
  || fail "creating a token without the right password was not refused"

echo "== a bad bearer never falls back to the session cookie"
[ "$(curl -sS -o /dev/null -w '%{http_code}' -b "$COOKIE_JAR" -H "Origin: $BASE" -H 'Authorization: Bearer ftk_nope' "$BASE/api/status")" = "401" ] \
  || fail "a bad bearer fell back to the cookie"

echo "== no credential: 401 with a resource_metadata URL that resolves"
[ "$(curl -sS -o /dev/null -D "$HEADERS_FILE" -w '%{http_code}' -X POST "$BASE/mcp" "${MCP_JSON[@]}" -d "$INIT")" = "401" ] \
  || fail "/mcp without a credential was not 401"
METADATA_URL="$(grep -i '^www-authenticate:' "$HEADERS_FILE" | grep -oE 'resource_metadata="[^"]+"' | cut -d'"' -f2)"
[ -n "$METADATA_URL" ] || fail "the 401 challenge names no resource_metadata"
curl -fsS "$METADATA_URL" | grep '"resource"' | grep '/mcp"' >/dev/null || fail "resource_metadata $METADATA_URL does not resolve to the MCP resource"

echo "== revoking a token ends it at once"
[ "$(authed_code -X POST "$BASE/ui/access/tokens/$READER_ID/revoke")" = "303" ] || fail "revoke did not redirect"
[ "$(mcp_status "$READ_TOKEN" "$INIT")" = "401" ] || fail "a revoked token still works"
grep -i '^www-authenticate:.*error="invalid_token"' "$HEADERS_FILE" >/dev/null || fail "revoked token lacks the invalid_token challenge"

echo "== setup is closed once claimed"
[ "$(http_code -X POST "$BASE/ui/setup" -H "Origin: $BASE" --data-urlencode "code=$SETUP_CODE" \
  --data-urlencode "username=other" --data-urlencode "password=$SMOKE_PASSWORD")" = "409" ] \
  || fail "/ui/setup still open after the claim"

echo "== restart: the owner and session persist, and NO new setup code is printed"
docker restart "$NAME" >/dev/null
wait_healthy
BASE="$(base_url)"
[ "$(setup_banner_count)" = "1" ] || fail "a restart printed another setup code"
[ "$(authed_code "$BASE/api/status")" = "200" ] || fail "session did not survive restart"
[ "$(mcp_status "$WRITE_TOKEN" "$INIT")" = "200" ] || fail "an access token did not survive restart"
authed -fS "$BASE/api/accounts" | grep '"Smoke"' >/dev/null || fail "account did not survive restart"
LOGIN_STATUS="$(curl -sS -o /dev/null -w '%{http_code}' -H "Origin: $BASE" -X POST "$BASE/ui/login" \
  --data-urlencode "username=$SMOKE_USER" --data-urlencode "password=$SMOKE_PASSWORD")"
[ "$LOGIN_STATUS" = "303" ] || fail "login after restart returned $LOGIN_STATUS, expected 303"

echo "== only /data is writable"
# /var/tmp is writable by `node` on a normal root filesystem, so this only fails under --read-only.
if docker exec "$NAME" sh -c 'touch /var/tmp/probe 2>/dev/null'; then fail "root filesystem is writable"; fi
docker exec "$NAME" sh -c 'touch /data/.probe && rm /data/.probe' || fail "/data is not writable"

echo "== key, password, session token and access tokens never leak into logs, env or volume"
# `grep -q` would exit early and SIGPIPE the producer, which pipefail reports as "no match".
if docker logs "$NAME" 2>&1 | grep "$KEY_VALUE" >/dev/null; then fail "key found in container logs"; fi
if docker inspect "$NAME" | grep "$KEY_VALUE" >/dev/null; then fail "key found in container config"; fi
if docker run --rm -v "$VOLUME":/data --entrypoint grep "$IMAGE" -rqF "$KEY_VALUE" /data; then fail "key found on the data volume"; fi
for SECRET in "$SMOKE_PASSWORD" "$SESSION_TOKEN" "$WRITE_TOKEN" "$READ_TOKEN"; do
  if docker logs "$NAME" 2>&1 | grep -F "$SECRET" >/dev/null; then fail "a credential was logged"; fi
  if docker run --rm -v "$VOLUME":/data --entrypoint grep "$IMAGE" -rqF "$SECRET" /data; then fail "a plaintext credential is on the data volume"; fi
done

echo "== no key source: fails fast with the openssl hint"
set +e
NOKEY_OUT="$(docker run --rm --name "$NAME-nokey" --read-only --tmpfs /tmp "$IMAGE" 2>&1)"
NOKEY_CODE=$?
set -e
[ "$NOKEY_CODE" -ne 0 ] || fail "container started without a key source"
echo "$NOKEY_OUT" | grep "openssl rand -hex 32" >/dev/null || { echo "$NOKEY_OUT" >&2; fail "missing openssl hint in logs"; }

echo "smoke OK"
