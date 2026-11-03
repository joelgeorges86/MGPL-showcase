#!/usr/bin/env bash
set -e
DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null 2>&1 && pwd )"
echo "=== Running Quality Gates (Q1-Q5) ==="
bash "$DIR/q1-lint.sh"
bash "$DIR/q2-test.sh"
bash "$DIR/q3-coverage.sh"
bash "$DIR/q4-bundle.sh"
bash "$DIR/q5-types.sh"
echo "=== All Quality Gates Passed ==="
