#!/usr/bin/env bash
set -euo pipefail
cd "$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null 2>&1 && pwd )/.."
echo "[Gate S2] Running Dependency Audit (npm audit — high/critical findings FAIL the gate)..."
npm audit --audit-level=high
echo "Gate S2 Dependency Audit passed."
