#!/usr/bin/env bash
# replay.sh [last_batch] -- land batches one at a time and run the models after
# each, the way a scheduled pipeline would. This is the INCREMENTAL path.
set -euo pipefail
source "$(dirname "$0")/env.sh"
LAST="${1:-7}"

"$WH_ROOT/scripts/reset.sh" >/dev/null
for b in $(seq 1 "$LAST"); do
  "$WH_ROOT/scripts/land.sh" "$b" | tail -1
  (cd "$WH_ROOT" && "$DBT_BIN" run --target dev -q) \
    || { echo "dbt run FAILED on batch $b"; exit 1; }
  echo "  batch $b: models built incrementally"
done
