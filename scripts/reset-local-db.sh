#!/usr/bin/env bash
#
# reset-local-db.sh — MANUAL dev convenience: delete the local FinTrack database.
#
# ⚠️  This permanently deletes your local fintrack.db (and its -wal/-shm sidecars).
#     It exists only so a developer can start from a clean seed (e.g. after the
#     English-canonical category change, ADR-009). It is intentionally NOT wired
#     into npm scripts, dev, test, or CI — run it by hand, on purpose, never as a
#     default flow. Do NOT use this against a database that holds data you care about.
#
# Usage:
#   scripts/reset-local-db.sh            # asks for confirmation
#   scripts/reset-local-db.sh --force    # skip the prompt (scripted use)
#   DB_PATH=/abs/path/fintrack.db scripts/reset-local-db.sh
#
# The encryption key in the OS keychain is left untouched: a fresh DB is recreated,
# encrypted with the same key, on the next server start.

set -euo pipefail

DB_PATH="${DB_PATH:-$HOME/.fintrack/fintrack.db}"
FORCE=0
[[ "${1:-}" == "--force" ]] && FORCE=1

if [[ ! -f "$DB_PATH" ]]; then
  echo "No database found at: $DB_PATH (nothing to delete)."
  exit 0
fi

echo "About to delete the local FinTrack database:"
echo "  $DB_PATH"
echo "  (plus ${DB_PATH}-wal and ${DB_PATH}-shm if present)"

if [[ "$FORCE" -ne 1 ]]; then
  read -r -p "Delete it? Type 'yes' to confirm: " reply
  if [[ "$reply" != "yes" ]]; then
    echo "Aborted. Nothing was deleted."
    exit 1
  fi
fi

rm -f -- "$DB_PATH" "${DB_PATH}-wal" "${DB_PATH}-shm"
echo "Deleted. The next server start will create a fresh, seeded database."
