#!/usr/bin/env bash
# Remove the demo Postgres. It has no volume, so this deletes its data too,
# which is the point: every demonstrate.sh run should start from nothing.
set -euo pipefail
source "$(dirname "$0")/env.sh"

if docker rm -f "$WH_CONTAINER" >/dev/null 2>&1; then
  echo "removed ${WH_CONTAINER}"
else
  echo "no container named ${WH_CONTAINER}"
fi
