#!/usr/bin/env bash
set -euo pipefail
cd "$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null 2>&1 && pwd )/.."
echo "[Gate S3] Running Secret Scan..."
node scripts/gate-secret-scan.js
echo "Gate S3 Secret Scan passed."
