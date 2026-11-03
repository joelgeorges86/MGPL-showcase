#!/usr/bin/env bash
set -euo pipefail
cd "$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null 2>&1 && pwd )/.."
echo "[Gate Q3] Running Code Coverage (Vitest v8, thresholds enforced)..."
npm run test:coverage
echo "Gate Q3 Coverage passed."
