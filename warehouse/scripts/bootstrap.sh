#!/usr/bin/env bash
# Create the landing schema and stage the whole sanitized sample file. Landing
# itself happens one batch at a time via land.sh.
set -euo pipefail
source "$(dirname "$0")/env.sh"

psqlq -q -f - < "$WH_ROOT/raw/001_landing.sql"
psqlq -q -c "TRUNCATE raw.sample_source_observations, raw.sample_application_status_events;"
docker exec -i "$WH_CONTAINER" psql -v ON_ERROR_STOP=1 -U "$WH_USER" -d "$WH_DB" \
  -c "\copy raw.sample_source_observations FROM STDIN WITH (FORMAT csv, HEADER true, FORCE_NOT_NULL (corrects_observation_id, correction_reason, requirements))" \
  < "$WH_ROOT/data/source_observations.csv"
docker exec -i "$WH_CONTAINER" psql -v ON_ERROR_STOP=1 -U "$WH_USER" -d "$WH_DB" \
  -c "\copy raw.sample_application_status_events FROM STDIN WITH (FORMAT csv, HEADER true, FORCE_NOT_NULL (from_status, evidence))" \
  < "$WH_ROOT/data/application_status_events.csv"
psqlq -tAc "SELECT 'staged observations: '||count(*) FROM raw.sample_source_observations;"
psqlq -tAc "SELECT 'staged status events: '||count(*) FROM raw.sample_application_status_events;"
