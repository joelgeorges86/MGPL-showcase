#!/bin/bash
# MGPL v1.1 - VCM Post-Restore Integrity Check
#
# Validation of the SQLite database after a Litestream restore or snapshot
# import. Verifies:
#   1. PRAGMA integrity_check reports 'ok'.
#   2. PRAGMA foreign_key_check reports zero orphaned references.
#   3. The 13 authoritative application tables exist (defense in depth).
#
# Usage:
#   DB_PATH=/data/mgpl-preprod.db ./scripts/vcm-integrity-check.sh
#
# Exits 0 on a clean bill of health, 1 on corruption/orphaned references.

set -euo pipefail

DB_PATH="${DB_PATH:-/data/mgpl-preprod.db}"

if ! command -v sqlite3 >/dev/null 2>&1; then
  echo "[vcm-integrity-check] ERROR: 'sqlite3' CLI not found. Install sqlite3 (e.g. apk add sqlite) before running this check." >&2
  exit 1
fi

if [ ! -f "$DB_PATH" ]; then
  echo "[vcm-integrity-check] ERROR: database file not found at '$DB_PATH'." >&2
  exit 1
fi

echo "[vcm-integrity-check] Checking database: $DB_PATH"

# 1. PRAGMA integrity_check must return exactly 'ok'.
integrity_result=$(sqlite3 "$DB_PATH" "PRAGMA integrity_check;")
if [ "$integrity_result" != "ok" ]; then
  echo "[vcm-integrity-check] FAIL: PRAGMA integrity_check reported corruption:" >&2
  echo "$integrity_result" >&2
  exit 1
fi
echo "[vcm-integrity-check] OK: PRAGMA integrity_check returned 'ok'."

# 2. Foreign key integrity check must return zero rows.
fk_violations=$(sqlite3 "$DB_PATH" "PRAGMA foreign_key_check;")
if [ -n "$fk_violations" ]; then
  echo "[vcm-integrity-check] FAIL: PRAGMA foreign_key_check reported orphaned references:" >&2
  echo "$fk_violations" >&2
  exit 1
fi
echo "[vcm-integrity-check] OK: foreign key integrity clean (0 violations)."

# 3. Verify the 13 authoritative tables exist (defense in depth).
AUTHORITATIVE_TABLES="
AppGames
Devices
AppWishlist
AppRetroTracking
AppGameTags
AppGameNotes
AppBacklog
AppPlaySessions
AppPriceAlerts
AppDealsWishlist
InstalledMods
AppCompletionRoadmapCache
AppTracking
"

missing=0
for table in $AUTHORITATIVE_TABLES; do
  count=$(sqlite3 "$DB_PATH" "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='$table';")
  if [ "$count" -eq 0 ]; then
    echo "[vcm-integrity-check] MISSING TABLE: $table" >&2
    missing=$((missing + 1))
  fi
done

if [ "$missing" -ne 0 ]; then
  echo "[vcm-integrity-check] FAIL: $missing of 13 authoritative tables are missing." >&2
  exit 1
fi
echo "[vcm-integrity-check] OK: all 13 authoritative tables present."

echo "[vcm-integrity-check] PASS: database integrity verified."
exit 0
