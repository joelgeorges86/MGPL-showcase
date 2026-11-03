#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPOSITORY_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
cd -- "$REPOSITORY_ROOT"

fail() {
  echo "[FAIL] $1" >&2
  exit 1
}

pass() {
  echo "[PASS] $1"
}

info() {
  echo "[INFO] $1"
}

if [[ "$(uname -sr 2>/dev/null)" =~ (Microsoft|microsoft|WSL|wsl) ]]; then
  fail "WSL is not supported; run this script through Windows Git Bash"
fi

if [[ ! -f "$REPOSITORY_ROOT/AGENTS.md" ||
  ! -f "$REPOSITORY_ROOT/package.json" ||
  ! -f "$REPOSITORY_ROOT/package-lock.json" ||
  ! -f "$REPOSITORY_ROOT/gates/run-all.sh" ]]; then
  fail "repository root could not be verified: $REPOSITORY_ROOT"
fi

status_before="$(git status --porcelain --untracked-files=all)"
temporary_database_path=""

cleanup_temporary_database() {
  if [[ -n "$temporary_database_path" ]]; then
    rm -f -- "$temporary_database_path" "${temporary_database_path}-wal" "${temporary_database_path}-shm"
  fi
}

trap cleanup_temporary_database EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Stage 1: fail before Doppler, npm, or database work.
branch_name="$(git branch --show-current)"
if [[ ! "$branch_name" =~ ^(feature|fix|hotfix)/.+ ]]; then
  fail "Stage 1 - repository and branch: invalid branch '$branch_name'; use feature/*, fix/*, or hotfix/*"
fi
pass "Stage 1 - repository root and branch: $REPOSITORY_ROOT; branch=$branch_name"

# Resolve Doppler using the same validated Windows fallback as run-gates.sh.
if command -v doppler >/dev/null 2>&1; then
  DOPPLER_COMMAND="doppler"
else
  DOPPLER_COMMAND=""
  for candidate in \
    "/c/Users/joelg/AppData/Local/Microsoft/WinGet/Links/doppler.exe"; do
    if [[ -f "$candidate" ]]; then
      DOPPLER_COMMAND="$candidate"
      break
    fi
  done
  [[ -n "$DOPPLER_COMMAND" ]] || fail "Doppler CLI could not be resolved from PATH or the validated Windows installation path"
fi

# Stage 2: bind the current directory only when it is not already bound correctly.
project="$("$DOPPLER_COMMAND" configure get project --plain 2>/dev/null || true)"
config="$("$DOPPLER_COMMAND" configure get config --plain 2>/dev/null || true)"
if [[ "$project" != "mgpl" || ! "$config" =~ ^dev ]]; then
  "$DOPPLER_COMMAND" setup --project mgpl --config dev >/dev/null || \
    fail "Stage 2 - Doppler binding: unable to bind this worktree to mgpl/dev"
  project="$("$DOPPLER_COMMAND" configure get project --plain 2>/dev/null || true)"
  config="$("$DOPPLER_COMMAND" configure get config --plain 2>/dev/null || true)"
fi
[[ "$project" == "mgpl" && "$config" =~ ^dev ]] || \
  fail "Stage 2 - Doppler binding: expected project=mgpl and config=dev"
pass "Stage 2 - Doppler binding: project=$project config=$config"

# Stage 3: prove injection without printing the value.
"$DOPPLER_COMMAND" run -- node -e \
  'if (typeof process.env.SESSION_SECRET !== "string" || process.env.SESSION_SECRET.length === 0) process.exit(1);' || \
  fail "Stage 3 - Doppler injection: required variable SESSION_SECRET was not present"
pass "Stage 3 - Doppler injection: required variable SESSION_SECRET is present (value hidden)"

# Stage 4: npm ls is read-only. Any uncertainty causes a deterministic npm ci.
needs_install=0
install_reason=""
if [[ ! -d "$REPOSITORY_ROOT/node_modules" ]]; then
  needs_install=1
  install_reason="node_modules is absent"
else
  npm_ls_log="$(mktemp)"
  if ! npm ls --depth=0 >"$npm_ls_log" 2>&1; then
    needs_install=1
    install_reason="npm ls --depth=0 reported missing or invalid dependencies"
  fi
  rm -f -- "$npm_ls_log"
fi

if (( needs_install )); then
  info "Stage 4 - dependencies: running npm ci ($install_reason)"
  npm ci || fail "Stage 4 - dependencies: npm ci failed"
else
  info "Stage 4 - dependencies: npm ls --depth=0 is consistent; npm ci not required"
fi

required_bins=(tsc vitest cspell ts-node)
for bin_name in "${required_bins[@]}"; do
  found=0
  for candidate in \
    "$REPOSITORY_ROOT/node_modules/.bin/$bin_name" \
    "$REPOSITORY_ROOT/node_modules/.bin/$bin_name.cmd"; do
    if [[ -f "$candidate" || -x "$candidate" ]]; then
      found=1
      break
    fi
  done
  (( found )) || fail "Stage 4 - dependencies: required executable '$bin_name' was not found, including .cmd wrappers"
done
pass "Stage 4 - dependencies: required executables resolve (tsc, vitest, cspell, ts-node)"

# Resolve the database inside Doppler. This mirrors the guard exactly:
# DB_PATH, resolved relative to the repository cwd, or mpgl_app.db by default.
db_info="$("$DOPPLER_COMMAND" run -- node - <<'NODE'
const path = require("path");
const configured = process.env.DB_PATH;
if (configured === ":memory:") {
  console.log(":memory:\tinjected DB_PATH");
} else if (configured) {
  console.log(`${path.resolve(process.cwd(), configured)}\tinjected DB_PATH`);
} else {
  console.log(`${path.resolve(process.cwd(), "mpgl_app.db")}\tguard default`);
}
NODE
)" || fail "Stage 5 - database: unable to resolve DB_PATH under Doppler"
IFS=$'\t' read -r db_path db_source <<< "$db_info"
[[ -n "$db_path" && "$db_path" != ":memory:" ]] || \
  fail "Stage 5 - database: DB_PATH=:memory: cannot provide persistent gate evidence"
info "Stage 5 - database: resolved path=$db_path source=$db_source"

inspect_existing_database() {
  "$DOPPLER_COMMAND" run -- env "DB_PATH=$db_path" node - <<'NODE'
const Database = require("better-sqlite3");

const databasePath = process.env.DB_PATH;
let db;
try {
  db = new Database(databasePath, { readonly: true, fileMustExist: true });
  const integrity = db.pragma("integrity_check", { simple: true });
  if (integrity !== "ok") {
    console.error(`[FAIL] database integrity_check=${integrity}`);
    process.exitCode = 1;
  }

  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all();
  const rowCounts = {};
  let totalRows = 0;
  for (const { name } of tables) {
    const quoted = `"${name.replace(/"/g, '""')}"`;
    const count = db.prepare(`SELECT COUNT(*) AS count FROM ${quoted}`).get().count;
    rowCounts[name] = count;
    totalRows += count;
  }

  let marker = "absent";
  if (rowCounts.mgpl_seed_marker > 0) {
    const row = db
      .prepare("SELECT seedIdentifier, seededAt FROM mgpl_seed_marker ORDER BY seededAt DESC LIMIT 1")
      .get();
    marker = `present identifier=${row.seedIdentifier} seededAt=${row.seededAt}`;
  }

  console.log(
    `[INFO] database state: integrity=ok rows=${totalRows} state=${totalRows === 0 ? "empty" : "populated"} marker=${marker}`,
  );
  console.log(`[INFO] database row counts: ${JSON.stringify(rowCounts)}`);
} catch (error) {
  console.error(`[FAIL] database inspection: ${error.message}`);
  process.exitCode = 1;
} finally {
  if (db) db.close();
}
NODE
}

database_sidecars_present() {
  [[ -e "${db_path}-wal" || -e "${db_path}-shm" ]]
}

verify_temporary_database() {
  "$DOPPLER_COMMAND" run -- env "DB_PATH=$temporary_database_path" node - <<'NODE'
const Database = require("better-sqlite3");

let db;
try {
  db = new Database(process.env.DB_PATH, { readonly: true, fileMustExist: true });
  const integrity = db.pragma("integrity_check", { simple: true });
  if (integrity !== "ok") {
    console.error(`[FAIL] temporary database integrity_check=${integrity}`);
    process.exitCode = 1;
  } else {
    console.log("[INFO] temporary database integrity_check=ok");
  }
} catch (error) {
  console.error(`[FAIL] temporary database verification: ${error.message}`);
  process.exitCode = 1;
} finally {
  if (db) db.close();
}
NODE
}

# Stage 5: existing databases are read-only; only a missing target is seeded.
if [[ -e "$db_path" || -e "${db_path}-wal" || -e "${db_path}-shm" ]]; then
  inspect_existing_database || fail "Stage 5 - database: existing database is not readable or failed integrity_check"
  pass "Stage 5 - database: existing database verified read-only; no seed/reset performed"
else
  info "Stage 5 - database: target is missing; seeding a temporary database in the target directory"
  "$DOPPLER_COMMAND" run -- node "$REPOSITORY_ROOT/scripts/lib/place-database.js" "$db_path" || \
    fail "Stage 5 - database: temporary seed or hard-link placement failed"
  temporary_database_path=""
  if [[ -e "$db_path" ]]; then
    inspect_existing_database || fail "Stage 5 - database: placed or competing database failed read-only verification"
  fi
  pass "Stage 5 - database: temporary database seeded and placed or competing target preserved"
fi

pass "Playwright browsers - CI-owned, not required locally."

# Stage 6: report setup-introduced changes. Never clean silently.
status_after="$(git status --porcelain --untracked-files=all)"
if [[ "$status_after" == "$status_before" ]]; then
  pass "Stage 6 - worktree cleanliness: no setup-introduced changes"
elif [[ -z "$status_before" ]]; then
  echo "[FAIL] Stage 6 - worktree cleanliness: setup introduced changes:" >&2
  printf '%s\n' "$status_after" >&2
  exit 1
else
  echo "[WARN] Stage 6 - worktree cleanliness: setup changed the tree; no cleanup performed"
  echo "[INFO] pre-setup status:"
  printf '%s\n' "$status_before"
  echo "[INFO] post-setup status:"
  printf '%s\n' "$status_after"
  fail "Stage 6 - worktree cleanliness: setup-introduced changes must be reviewed before gates"
fi

# Stage 7: doctor is the final setup verification and is not duplicated here.
npm run doctor || fail "Stage 7 - npm run doctor"
pass "Stage 7 - npm run doctor"

pass "Worktree setup complete: reduced local gate chain is ready; Playwright remains CI-owned."