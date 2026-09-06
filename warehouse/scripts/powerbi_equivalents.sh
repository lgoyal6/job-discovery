#!/usr/bin/env bash
# Run the SQL equivalents of the DAX measures against the built warehouse.
# This is the only part of the Power BI work that can actually be executed here.
set -euo pipefail
source "$(dirname "$0")/env.sh"
docker exec -i "$WH_CONTAINER" psql -v ON_ERROR_STOP=1 -U "$WH_USER" -d "$WH_DB" \
  < "$WH_ROOT/powerbi/measure_equivalents.sql"
