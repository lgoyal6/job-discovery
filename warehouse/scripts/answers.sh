#!/usr/bin/env bash
# The three analytical answers, each printed next to the denominator it is
# divided by. Run against the incrementally built warehouse by default.
set -euo pipefail
source "$(dirname "$0")/env.sh"
S="${1:-jm_wh}"

echo "==== Q1. Which sources yield unique eligible roles? [$S]"
echo "     denominator: eligible_requisition_universe, distinct eligible requisitions in the window"
psqlq -c "select source_name, eligible_requisition_universe as denom, observed_eligible,
                 sole_source_eligible, first_observer_eligible,
                 pct_of_eligible_universe_observed as pct_observed,
                 pct_of_eligible_universe_sole_source as pct_sole,
                 avg_hours_behind_first_observer as avg_hrs_behind
          from $S.mart_source_unique_yield;"

echo "==== Q2. How quickly are stale listings detected? [$S]"
echo "     denominator: only requisitions observed OPEN and later observed CLOSED"
psqlq -c "select coverage_bucket, requisitions, pct_of_population from $S.mart_stale_detection_coverage;"
psqlq -c "select count(*) as measurable_requisitions,
                 round(avg(detection_latency_hours),1) as mean_hours,
                 round(percentile_cont(0.5) within group (order by detection_latency_hours)::numeric,1) as median_hours,
                 min(detection_latency_hours) as min_hours,
                 max(detection_latency_hours) as max_hours
          from $S.mart_stale_detection_latency;"
psqlq -c "select company, title, detected_by_source, source_count, observation_count,
                 detection_latency_hours
          from $S.mart_stale_detection_latency order by detection_latency_hours desc;"

echo "==== Q3. Which requirements recur by role family? [$S]"
echo "     denominator: requisitions in that family that were observed WITH requirements text"
psqlq -c "select role_family, family_requisitions_total as family_total,
                 family_requisitions_with_requirements as denom,
                 family_text_coverage_pct as text_coverage_pct,
                 requirement, requisitions_naming_it as n, pct_of_covered_requisitions as pct
          from $S.mart_requirement_recurrence
          order by role_family, requisitions_naming_it desc, requirement;"

echo "==== Tracker, reported for what it is [$S]"
psqlq -c "select * from $S.mart_application_funnel;"
