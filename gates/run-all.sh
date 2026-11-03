#!/usr/bin/env bash
set -e
DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null 2>&1 && pwd )"
echo "========================================"
echo " Running Master Gate Verification Suite"
echo "========================================"
bash "$DIR/security.sh"
echo ""
bash "$DIR/quality.sh"
echo ""
echo "========================================"
echo " ALL SECURITY & QUALITY GATES PASSED "
echo "========================================"
