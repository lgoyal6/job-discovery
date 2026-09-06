#!/usr/bin/env bash
# The four numbers the late correction is supposed to move. Run against
# whichever schema is passed so incremental and full-rebuild can be compared
# side by side. Nothing here is derived; each figure comes straight from a model.
set -euo pipefail
source "$(dirname "$0")/env.sh"
S="${1:-jm_wh}"

echo "--- [$S] A. day-2 community row in fct_source_observation_day (the corrected day)"
psqlq -c "select source_name, observation_date, observation_count, requisition_count,
                 open_observation_count, closed_observation_count,
                 late_arriving_observation_count, restated_fetch_count
          from $S.fct_source_observation_day
          where source_name='community' and observation_date='2026-08-04';"

echo "--- [$S] B. correction rows that reached staging (expect 3)"
psqlq -c "select count(*) as correction_rows_in_staging
          from $S.stg_source_observations
          where ingested_at > '2026-08-08 23:59:00+00';"

echo "--- [$S] C. detection latency for the corrected requisition"
psqlq -c "select company, title, last_observed_open_at, first_observed_closed_at,
                 detected_by_source, detection_latency_hours
          from $S.mart_stale_detection_latency
          where canonical_key like 'bluewatercapital::quantitativeresearch%';"

echo "--- [$S] D. all measured detection latencies"
psqlq -c "select company, title, detected_by_source, detection_latency_hours
          from $S.mart_stale_detection_latency order by detection_latency_hours desc;"
