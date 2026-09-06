#!/usr/bin/env bash
# The three declared grains, each proved by a uniqueness check rather than
# asserted in a comment. A grain that is only written down is a wish.
set -euo pipefail
source "$(dirname "$0")/env.sh"
S="${1:-jm_wh}"

echo "=== GRAIN 1: one source observation per fetch (source, source_job_id, observed_at)"
psqlq -c "select count(*) as staging_rows,
                 count(distinct (source_name, source_job_id, observed_at, revision)) as distinct_fetch_revisions,
                 count(distinct (source_name, source_job_id, observed_at)) as distinct_fetches
          from $S.stg_source_observations;"
psqlq -c "select count(*) as fetch_grain_rows,
                 count(distinct fetch_key) as distinct_fetch_keys,
                 count(*) filter (where was_restated) as rows_from_restated_fetches
          from $S.int_fetch_observations;"
psqlq -c "select 'DUPLICATE FETCH KEYS: '||count(*) from (
            select fetch_key from $S.int_fetch_observations group by fetch_key having count(*)>1) d;"

echo "=== GRAIN 2: one version per canonical requisition change"
psqlq -c "select count(*) as version_rows,
                 count(distinct canonical_key) as requisitions,
                 count(*) filter (where is_current_version) as current_versions,
                 count(distinct material_fingerprint) as distinct_fingerprints
          from $S.dim_requisition_version;"
psqlq -c "select 'VERSIONS WHOSE FINGERPRINT EQUALS THE PRIOR ONE (should be 0): '||count(*) from (
            select canonical_key, material_fingerprint,
                   lag(material_fingerprint) over (partition by canonical_key order by version_seq) as prev
            from $S.dim_requisition_version) v where prev = material_fingerprint;"
psqlq -c "select canonical_key, version_seq, minted_by_source, title, location,
                 valid_from_observed_at, valid_to_observed_at, is_current_version
          from $S.dim_requisition_version
          where canonical_key in (select canonical_key from $S.dim_requisition_version
                                  group by canonical_key having count(*)>1)
          order by canonical_key, version_seq;"

echo "=== GRAIN 3: one recorded application-status transition"
psqlq -c "select count(*) as transition_rows,
                 count(distinct event_id) as distinct_events,
                 count(distinct canonical_key) as requisitions_with_a_transition
          from $S.fct_application_status_transition;"
psqlq -c "select 'CHAIN BREAKS (prev_to_status <> from_status), should be 0: '||count(*)
          from $S.fct_application_status_transition
          where prev_to_status is distinct from from_status and transition_seq > 1;"

echo "=== THE THREE CLOCKS ARE SEPARATE COLUMNS, never collapsed"
psqlq -c "select count(*) as rows,
                 count(*) filter (where posted_at is not null) as have_posted_at,
                 count(*) filter (where observed_at <> ingested_at) as observed_differs_from_ingested,
                 count(*) filter (where observed_at::date <> ingested_at::date) as differ_by_a_whole_day,
                 min(observed_at) as earliest_observed, max(observed_at) as latest_observed,
                 min(ingested_at) as earliest_ingested, max(ingested_at) as latest_ingested
          from $S.stg_source_observations;"
