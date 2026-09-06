#!/usr/bin/env bash
# swap.sh <naive|negative_control|shipped> -- put a demo variant of the two
# incremental models in place, or restore the shipped ones.
#
# File swapping rather than a dbt var, on purpose: the fix under demonstration
# is a change to the model's SQL, so the demonstration should change the model's
# SQL. demo/shipped holds byte-exact copies of the real models.
set -euo pipefail
source "$(dirname "$0")/env.sh"
VARIANT="${1:?usage: swap.sh <naive|negative_control|shipped>}"
SRC="$WH_ROOT/demo/$VARIANT"
[ -d "$SRC" ] || { echo "no such variant: $VARIANT"; exit 1; }

for f in "$SRC"/*.sql; do
  base="$(basename "$f")"
  case "$base" in
    stg_*)  dest="$WH_ROOT/models/staging/$base" ;;
    fct_source_observation_day.sql) dest="$WH_ROOT/models/marts/$base" ;;
    *)      echo "unmapped file: $base"; exit 1 ;;
  esac
  cp "$f" "$dest"
  echo "swapped in $VARIANT/$base"
done
