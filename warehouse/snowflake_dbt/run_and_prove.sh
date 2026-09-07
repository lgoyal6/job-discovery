#!/usr/bin/env bash
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
dbt_args=(--project-dir "$here" --profiles-dir "$here")

# Initial snapshot, then the late-arriving correction in batch 7.
dbt seed "${dbt_args[@]}" --target dev --full-refresh
dbt run "${dbt_args[@]}" --target dev --full-refresh --vars '{max_batch: 6}'
dbt run "${dbt_args[@]}" --target dev --vars '{max_batch: 7}'

# Independent clean rebuild and symmetric MINUS parity test.
dbt seed "${dbt_args[@]}" --target full --full-refresh
dbt run "${dbt_args[@]}" --target full --full-refresh --vars '{max_batch: 7}'
dbt test "${dbt_args[@]}" --target dev --select assert_incremental_matches_full

python "$here/verify_ops.py"
