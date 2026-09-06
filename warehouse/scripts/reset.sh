#!/usr/bin/env bash
# Empty the landing zone and drop both build schemas. Used between demo runs so
# every measurement starts from the same place.
set -euo pipefail
source "$(dirname "$0")/env.sh"
psqlq -tAc "
TRUNCATE raw.source_observations, raw.application_status_events;
DROP SCHEMA IF EXISTS jm_wh CASCADE;
DROP SCHEMA IF EXISTS jm_wh_full CASCADE;
SELECT 'reset: landing empty, jm_wh and jm_wh_full dropped';"
