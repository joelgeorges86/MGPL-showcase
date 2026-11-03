#!/usr/bin/env bash
set -euo pipefail
cd "$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null 2>&1 && pwd )/.."
echo "[Gate Q4] Checking Bundle Size..."
node scripts/gate-bundle.js
echo "Gate Q4 Bundle Size passed."
