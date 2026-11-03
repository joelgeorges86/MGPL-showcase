#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPOSITORY_ROOT="$(cd -- "$SCRIPT_DIR/../../../../" && pwd)"
cd -- "$REPOSITORY_ROOT"

if [[ "$(uname -sr 2>/dev/null)" =~ (Microsoft|microsoft|WSL|wsl) ]]; then
  echo "WSL launchers are not supported; run this script through Windows Git Bash or the PowerShell runner." >&2
  exit 1
fi

if [[ ! -f package.json || ! -f gates/run-all.sh ]]; then
  echo "MGPL repository root could not be verified: $REPOSITORY_ROOT" >&2
  exit 1
fi

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
  if [[ -z "$DOPPLER_COMMAND" ]]; then
    echo "Doppler CLI could not be resolved from PATH or the validated Windows installation path." >&2
    exit 1
  fi
  echo "Using Doppler fallback executable: $DOPPLER_COMMAND"
fi

run_stage() {
  local name="$1"
  shift
  echo
  echo "=== $name ==="
  echo "+ $*"
  "$@"
}

run_stage "AGENTS.md integrity" npm run check:agents
run_stage "Environment doctor" npm run doctor
run_stage "TypeScript" "$DOPPLER_COMMAND" run -- npm run test:types
run_stage "Client syntax" "$DOPPLER_COMMAND" run -- npm run test:client
run_stage "Spelling" "$DOPPLER_COMMAND" run -- npm run test:spell
run_stage "Unit tests" "$DOPPLER_COMMAND" run -- npm run test:unit
run_stage "Security and quality gates" "$DOPPLER_COMMAND" run -- bash gates/run-all.sh

echo
echo "All MGPL gates passed."
run_stage "Record gate evidence" env MGPL_GATE_RUNNER_ID=bash MGPL_GATE_SCOPE=local "$DOPPLER_COMMAND" run -- node scripts/mgpl-gate-guard.js record