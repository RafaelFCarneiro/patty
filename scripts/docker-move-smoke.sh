#!/usr/bin/env bash
# Smoke-test the npm -> Docker move of docs/auth.md ("Moving an npm install to Docker") end to end: an npm-style
# database (claimed owner, one account, written through the stdio server) is exported with `key export` and `db export`,
# loaded into the compose volume with the guide's own commands, and the image is started with the exported key. The
# owner must log in with the password they chose on npm (no setup code), see the account, and the counts must match.
# Usage: scripts/docker-move-smoke.sh [image]   (default: fintrack:ci; run from the repository root)
set -euo pipefail

IMAGE="${1:-fintrack:ci}"
REPO="$(pwd)"
PROJECT="fintrack-move-$$"
WORKDIR="$(mktemp -d)"
COMPOSE_DIR="$WORKDIR/compose"
NPM_DIR="$WORKDIR/npm"
OWNER="mover"
OWNER_PASSWORD="$(openssl rand -hex 16)"   # 32 chars; throwaway
ACCOUNT_NAME="MovedAccount"
KEY_VALUE="$(openssl rand -hex 32)"        # the npm install's key (what the OS keychain would hold)
# The commands run from the compose directory (as in the guide), so tsx is resolved from here, not from there.
TSX="$(node --input-type=module -e "console.log(import.meta.resolve('tsx'))")"
FINTRACK=(node --import "$TSX" "$REPO/src/main.ts")

mkdir -p "$COMPOSE_DIR" "$NPM_DIR"

# The guide runs `docker compose …` in the compose directory; here the same commands run against this repository's
# compose.yaml, with the image under test and an ephemeral host port.
cat > "$WORKDIR/override.yaml" <<YAML
services:
  fintrack:
    image: $IMAGE
    ports: !override
      - '127.0.0.1::51737'
YAML
compose() { docker compose -p "$PROJECT" -f "$REPO/compose.yaml" -f "$WORKDIR/override.yaml" --project-directory "$COMPOSE_DIR" "$@"; }

cleanup() {
  compose down -v >/dev/null 2>&1 || true
  rm -rf "$WORKDIR"
}
trap cleanup EXIT

fail() { echo "FAIL: $*" >&2; compose logs fintrack >&2 2>&1 || true; exit 1; }

# The npm side: its own database and key, in the environment as a CI or headless install would have them.
npm_side() { DB_PATH="$NPM_DIR/fintrack.db" FINTRACK_DB_KEY="$KEY_VALUE" "$@"; }

echo "== npm side: claim the owner, then add an account through the stdio server"
printf '%s\n' "$OWNER_PASSWORD" | npm_side "${FINTRACK[@]}" auth setup --username "$OWNER" --password-stdin >/dev/null \
  || fail "auth setup failed"
{
  printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}'
  printf '%s\n' '{"jsonrpc":"2.0","method":"notifications/initialized"}'
  printf '%s\n' "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"create_account\",\"arguments\":{\"name\":\"$ACCOUNT_NAME\",\"type\":\"checking\",\"currency\":\"USD\"}}}"
  sleep 6   # the server answers, then ends with its stdin
} | npm_side env FINTRACK_AUTH=disabled FINTRACK_HTTP=false "${FINTRACK[@]}" >"$WORKDIR/stdio.out" 2>&1 || true
grep -F "$ACCOUNT_NAME" "$WORKDIR/stdio.out" >/dev/null || { cat "$WORKDIR/stdio.out" >&2; fail "the stdio server did not create the account"; }

echo "== guide step 3: export the key and the data (key never printed, files owner-only)"
cd "$COMPOSE_DIR"
(umask 077; npm_side "${FINTRACK[@]}" key export --to ./fintrack_db_key >"$WORKDIR/key-export.out" 2>&1) || { cat "$WORKDIR/key-export.out" >&2; fail "key export failed"; }
npm_side "${FINTRACK[@]}" db export --to ./fintrack.snapshot.db >"$WORKDIR/db-export.out" 2>&1 || { cat "$WORKDIR/db-export.out" >&2; fail "db export failed"; }
[ "$(cat ./fintrack_db_key)" = "$KEY_VALUE" ] || fail "the exported key file does not hold the npm key"
if cat "$WORKDIR/key-export.out" "$WORKDIR/db-export.out" "$WORKDIR/stdio.out" | grep -F "$KEY_VALUE" >/dev/null; then fail "the key was printed"; fi
mode() { stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1"; }  # GNU first: BSD's -f is a different flag on Linux
[ "$(mode ./fintrack_db_key)" = "600" ] || fail "key file is not 0600"
[ "$(mode ./fintrack.snapshot.db)" = "600" ] || fail "snapshot is not 0600"
EXPECTED_ACCOUNTS="$(grep -oE 'accounts [0-9]+' "$WORKDIR/db-export.out" | awk '{print $2}')"
[ "$EXPECTED_ACCOUNTS" = "1" ] || fail "db export reported $EXPECTED_ACCOUNTS accounts, expected 1"
if npm_side "${FINTRACK[@]}" key export --to ./fintrack_db_key >/dev/null 2>&1; then fail "key export overwrote a file"; fi

echo "== guide step 4: put the snapshot into the fintrack-data volume as /data/fintrack.db (owned by the image's user)"
compose create >/dev/null
IMAGE_VERSION="$(compose run --rm --no-deps --entrypoint node fintrack -p "require('./package.json').version")" || fail "could not read the image's version"
[ -n "$IMAGE_VERSION" ] || fail "the image reports no version"
compose run --rm --no-deps -T --entrypoint sh fintrack \
  -c 'umask 077; cat > /data/fintrack.db && chmod 600 /data/fintrack.db' < ./fintrack.snapshot.db || fail "loading the snapshot into the volume failed"

echo "== guide step 5: key readable by the container's user, then up"
# Docker Desktop maps ownership itself; on Linux the 0600 file must belong to uid 1000 (CI may lack sudo: widen instead).
if [ "$(uname)" = "Linux" ]; then sudo -n chown 1000 ./fintrack_db_key 2>/dev/null || chmod 0444 ./fintrack_db_key; fi
compose up -d >/dev/null
BASE=""
for _ in $(seq 1 60); do
  PORT="$(compose port fintrack 51737 2>/dev/null | awk -F: '{print $NF}')"
  if [ -n "$PORT" ] && curl -fsS "http://127.0.0.1:$PORT/api/health" 2>/dev/null | grep '"db":"ok"' >/dev/null; then BASE="http://127.0.0.1:$PORT"; break; fi
  sleep 2
done
[ -n "$BASE" ] || fail "the container never reported a healthy database"

echo "== guide step 6: the owner was already claimed on npm — no setup code, log in with the same password"
if compose logs fintrack 2>&1 | grep 'first-time setup' >/dev/null; then fail "a setup code was printed for an already-claimed owner"; fi
COOKIE_JAR="$WORKDIR/cookies"
LOGIN_STATUS="$(curl -sS -o /dev/null -w '%{http_code}' -c "$COOKIE_JAR" -H "Origin: $BASE" -X POST "$BASE/ui/login" \
  --data-urlencode "username=$OWNER" --data-urlencode "password=$OWNER_PASSWORD")"
[ "$LOGIN_STATUS" = "303" ] || fail "login returned $LOGIN_STATUS, expected 303"

echo "== guide step 7: the account is there, and the counts match what db export printed"
ACCOUNTS_JSON="$(curl -fsS -b "$COOKIE_JAR" -H "Origin: $BASE" "$BASE/api/accounts")"
echo "$ACCOUNTS_JSON" | grep -F "\"$ACCOUNT_NAME\"" >/dev/null || fail "/api/accounts does not list $ACCOUNT_NAME"
[ "$(echo "$ACCOUNTS_JSON" | grep -o '"name"' | wc -l | tr -d ' ')" = "$EXPECTED_ACCOUNTS" ] || fail "the account count differs from db export's"

echo "move smoke OK"
