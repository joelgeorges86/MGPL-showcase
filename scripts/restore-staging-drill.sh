#!/usr/bin/env bash
set -euo pipefail

# Canonical PI-004 DR restore drill entry point. The implementation is kept in
# staging-restore-drill.sh for backward compatibility with the original package
# script name.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "${SCRIPT_DIR}/staging-restore-drill.sh" "$@"
