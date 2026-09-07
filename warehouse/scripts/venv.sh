#!/usr/bin/env bash
# Build the virtualenv these scripts run dbt out of. Idempotent: if DBT_BIN is
# already executable it prints the version and stops.
#
# It lives at warehouse/.venv (gitignored). DBT_BIN used to default into
# ../.agent-work/warehouse/venv, a personal working directory that is in a
# global gitignore and therefore does not exist in any clone, so there was no
# dbt to run and nothing documented that would build one.
set -euo pipefail
source "$(dirname "$0")/env.sh"

if [ -x "$DBT_BIN" ]; then
  echo "dbt already installed: $DBT_BIN"
  "$DBT_BIN" --version
  exit 0
fi

VENV="$WH_ROOT/.venv"
if [ "$DBT_BIN" != "$VENV/bin/dbt" ]; then
  echo "warehouse: DBT_BIN is set to $DBT_BIN, which is not executable." >&2
  echo "Unset DBT_BIN to let this script build $VENV, or point it at a real dbt." >&2
  exit 1
fi

PY="${WH_PYTHON:-python3}"
echo "creating $VENV with $PY"
"$PY" -m venv "$VENV"
"$VENV/bin/pip" install --quiet --upgrade pip
"$VENV/bin/pip" install --quiet -r "$WH_ROOT/requirements.txt"
"$DBT_BIN" --version
