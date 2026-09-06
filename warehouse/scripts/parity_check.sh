#!/usr/bin/env bash
# THE COMPLETION TEST: the incrementally built warehouse must be row-identical
# to a clean rebuild over the same landing snapshot.
#
# Compared with a symmetric EXCEPT so a row present on one side only, or
# differing in any column, is caught. No model writes now() or any other
# build-time value, so an exact comparison is meaningful rather than noise.
set -euo pipefail
source "$(dirname "$0")/env.sh"

MODELS="stg_source_observations stg_application_status_events dim_requisition_version dim_requisition_current fct_application_status_transition fct_source_observation_day mart_source_unique_yield mart_stale_detection_latency mart_stale_detection_coverage mart_requirement_recurrence mart_application_funnel"

FAIL=0
printf '%-40s %10s %10s %8s %8s  %s\n' MODEL INCREMENTAL FULL INC_ONLY FULL_ONLY RESULT
for m in $MODELS; do
  read -r inc full a b <<<"$(psqlq -tA -F' ' -c "
    select
      (select count(*) from jm_wh.$m),
      (select count(*) from jm_wh_full.$m),
      (select count(*) from (select * from jm_wh.$m except select * from jm_wh_full.$m) x),
      (select count(*) from (select * from jm_wh_full.$m except select * from jm_wh.$m) y);")"
  if [ "$a" = "0" ] && [ "$b" = "0" ] && [ "$inc" = "$full" ]; then res=MATCH; else res=MISMATCH; FAIL=1; fi
  printf '%-40s %10s %10s %8s %8s  %s\n' "$m" "$inc" "$full" "$a" "$b" "$res"
done

echo
if [ "$FAIL" = "0" ]; then
  echo "PARITY: PASS -- incremental output is identical to a clean full rebuild."
  exit 0
else
  echo "PARITY: FAIL -- incremental output diverges from a clean full rebuild."
  exit 1
fi
