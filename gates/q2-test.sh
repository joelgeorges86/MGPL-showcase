#!/usr/bin/env bash
set -euo pipefail
cd "$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null 2>&1 && pwd )/.."
echo "[Gate Q2] Running Unit Tests (Vitest)..."
npm run test:unit
echo "Gate Q2 Unit Tests passed."
