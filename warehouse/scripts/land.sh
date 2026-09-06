#!/usr/bin/env bash
# land.sh <batch_id> -- append one batch into the landing zone, the way a
# scheduled pipeline pass would. ON CONFLICT DO NOTHING because landing the
# same batch twice must be a no-op, not a duplicate row.
set -euo pipefail
source "$(dirname "$0")/env.sh"
BATCH="${1:?usage: land.sh <batch_id>}"

psqlq -tAc "
INSERT INTO raw.source_observations
SELECT * FROM raw.sample_source_observations WHERE batch_id = ${BATCH}
ON CONFLICT (observation_id) DO NOTHING;
INSERT INTO raw.application_status_events
SELECT * FROM raw.sample_application_status_events WHERE batch_id = ${BATCH}
ON CONFLICT (event_id) DO NOTHING;
SELECT 'batch ${BATCH} landed. observations='||(SELECT count(*) FROM raw.source_observations)
     ||' status_events='||(SELECT count(*) FROM raw.application_status_events);"
