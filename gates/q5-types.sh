#!/usr/bin/env bash
set -euo pipefail
cd "$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null 2>&1 && pwd )/.."
echo "[Gate Q5] Running Type Check (npx tsc --noEmit)..."
npx tsc --noEmit
echo "Gate Q5 Type Check passed."
