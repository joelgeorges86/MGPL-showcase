#!/usr/bin/env bash
set -e
DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null 2>&1 && pwd )"
echo "=== Running Security Gates (S1-S4) ==="
bash "$DIR/s1-sast.sh"
bash "$DIR/s2-dep-audit.sh"
bash "$DIR/s3-secret-scan.sh"
bash "$DIR/s4-transport.sh"
echo "=== All Security Gates Passed ==="
