#!/usr/bin/env bash
# The whole late-correction demonstration, start to finish, in one command.
#
# Each stage does the same three things so the stages are comparable:
#   replay      land batches 1..7 one at a time, running the models after each
#               (this is the INCREMENTAL path, the one under test)
#   full        rebuild every model from scratch on the same landing snapshot
#               (this is the REFERENCE, and --full-refresh means the incremental
#               branches are not compiled at all, so every stage's reference is
#               byte-identical)
#   parity      symmetric EXCEPT between the two schemas, every model
#
# Stage 1 and 2 are the bug. Stage 3 is the fix. Stages 4 and 5 are negative
# controls: deliberately broken incremental logic that still RUNS, to prove the
# parity check can actually fail. Stage 6 restores and re-proves green.
set -uo pipefail
source "$(dirname "$0")/env.sh"
cd "$WH_ROOT"

stage() {
  echo
  echo "==================================================================="
  echo "STAGE $1"
  echo "==================================================================="
}

run_stage() {   # run_stage <label>
  "$WH_ROOT/scripts/replay.sh" 7 >/dev/null 2>&1 || { echo "replay FAILED"; return 1; }
  echo "-- incremental replay of batches 1..7 complete"
  "$WH_ROOT/scripts/full_rebuild.sh" >/dev/null 2>&1 || { echo "full rebuild FAILED"; return 1; }
  echo "-- clean full rebuild complete"
  echo
  "$WH_ROOT/scripts/parity_check.sh"
  return 0
}

trap 'echo; echo "restoring shipped models"; "$WH_ROOT/scripts/swap.sh" shipped >/dev/null' EXIT

# Prerequisites, in order, each fatal. This script runs with `set -uo pipefail`
# and no `-e`, so without the explicit exits below a dead database produced a
# full six-stage transcript with an error interleaved into every stage, which
# reads like a demo that ran.
"$WH_ROOT/scripts/up.sh"        || exit 1
"$WH_ROOT/scripts/venv.sh"      || exit 1
"$WH_ROOT/scripts/bootstrap.sh" || exit 1

stage "1/6  MISTAKE 1 + 2 -- naive staging cursor (observed_at) and naive day fact"
"$WH_ROOT/scripts/swap.sh" naive
run_stage
echo
"$WH_ROOT/scripts/inspect_correction.sh" jm_wh
echo "--- the same four figures from the clean full rebuild, for comparison"
"$WH_ROOT/scripts/inspect_correction.sh" jm_wh_full

stage "2/6  MISTAKE 2 ALONE -- staging fixed, day fact still appends new dates only"
cp "$WH_ROOT/demo/shipped/stg_source_observations.sql" "$WH_ROOT/models/staging/"
cp "$WH_ROOT/demo/naive/fct_source_observation_day.sql" "$WH_ROOT/models/marts/"
echo "swapped in shipped/stg_source_observations.sql + naive/fct_source_observation_day.sql"
run_stage
echo
"$WH_ROOT/scripts/inspect_correction.sh" jm_wh | sed -n '1,12p'

stage "3/6  THE FIX -- shipped models, both cursors on the ingestion clock"
"$WH_ROOT/scripts/swap.sh" shipped
run_stage
echo
"$WH_ROOT/scripts/inspect_correction.sh" jm_wh
echo "--- dbt test against the incrementally built warehouse"
"$DBT_BIN" test --target dev 2>&1 | tail -6

stage "4/6  NEGATIVE CONTROL 1 -- interval start read off the wrong clock"
cp "$WH_ROOT/demo/negative_control/fct_source_observation_day.sql" "$WH_ROOT/models/marts/"
echo "swapped in negative_control/fct_source_observation_day.sql"
run_stage

stage "5/6  NEGATIVE CONTROL 2 -- interval half open on the wrong side"
cp "$WH_ROOT/demo/negative_control_2/fct_source_observation_day.sql" "$WH_ROOT/models/marts/"
echo "swapped in negative_control_2/fct_source_observation_day.sql"
run_stage

stage "6/6  RESTORE -- shipped models back in place, parity green again"
"$WH_ROOT/scripts/swap.sh" shipped
run_stage
