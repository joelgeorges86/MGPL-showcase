#!/usr/bin/env bash
set -euo pipefail
cd "$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null 2>&1 && pwd )/.."
echo "[Gate S4] Checking Transport Security..."
node scripts/gate-transport.js
echo "Gate S4 Transport Security passed."
