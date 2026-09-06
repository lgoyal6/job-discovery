#!/usr/bin/env bash
# Thin wrapper so every dbt invocation in this project uses the same venv,
# profiles directory and working directory.
set -euo pipefail
source "$(dirname "$0")/env.sh"
cd "$WH_ROOT"
exec "$DBT_BIN" "$@"
