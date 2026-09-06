#!/usr/bin/env bash
# Clean rebuild of every model from the same landing snapshot, into its own
# schema. Nothing is landed here: the snapshot is whatever replay.sh left.
set -euo pipefail
source "$(dirname "$0")/env.sh"
(cd "$WH_ROOT" && "$DBT_BIN" run --target full --full-refresh -q)
echo "full rebuild complete into jm_wh_full"
