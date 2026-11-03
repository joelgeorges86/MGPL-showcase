#!/usr/bin/env bash
set -euo pipefail
cd "$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null 2>&1 && pwd )/.."
echo "[Gate S1] Running Static Application Security Testing (SAST)..."
node scripts/gate-sast.js
echo "Gate S1 SAST passed."
