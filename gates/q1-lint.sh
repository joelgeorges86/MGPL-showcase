#!/usr/bin/env bash
set -euo pipefail
cd "$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null 2>&1 && pwd )/.."
echo "[Gate Q1] Running structural lint check..."
node scripts/gate-lint.js
echo "[Gate Q1] Checking gate-runner consistency..."
node scripts/check-gate-runner-consistency.js
# ESLint and Prettier check the files changed since MGPL_LINT_BASE. CI sets it
# for each event; a local gate run uses "auto", the base the Environment doctor
# picks (origin/develop, or origin/main for a branch cut from main).
export MGPL_LINT_BASE="${MGPL_LINT_BASE:-auto}"
echo "[Gate Q1] Running ESLint on the files this branch changes..."
npm run lint
echo "[Gate Q1] Running Prettier check on the files this branch changes..."
npm run format:check
echo "Gate Q1 Lint passed."
