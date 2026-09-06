# Connection and paths for every script in this directory. Sourced, not run.
export WH_CONTAINER="${WH_CONTAINER:-jobmarket-warehouse-dbt}"
export WH_HOST="${WH_HOST:-127.0.0.1}"
export WH_PORT="${WH_PORT:-55439}"
export WH_USER="${WH_USER:-warehouse}"
export WH_PASSWORD="${WH_PASSWORD:-warehouse}"
export WH_DB="${WH_DB:-jobmarket_wh}"
# Resolve the project root by walking up for dbt_project.yml. BASH_SOURCE is
# unset when this file is sourced from zsh, so it cannot be relied on.
_wh_find_root() {
  local d="${WH_ROOT:-$PWD}"
  while [ "$d" != "/" ]; do
    [ -f "$d/dbt_project.yml" ] && { echo "$d"; return; }
    d="$(dirname "$d")"
  done
  echo "warehouse: no dbt_project.yml at or above ${WH_ROOT:-$PWD}; set WH_ROOT to the warehouse directory" >&2
}
export WH_ROOT="$(_wh_find_root)"
[ -n "$WH_ROOT" ] || return 1
export DBT_BIN="${DBT_BIN:-$(cd "$WH_ROOT/.." && pwd)/.agent-work/warehouse/venv/bin/dbt}"
export DBT_PROFILES_DIR="$WH_ROOT"

psqlq() { docker exec -i "$WH_CONTAINER" psql -v ON_ERROR_STOP=1 -U "$WH_USER" -d "$WH_DB" "$@"; }
dbtrun() { (cd "$WH_ROOT" && "$DBT_BIN" "$@"); }
