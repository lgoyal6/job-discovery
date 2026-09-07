# Connection and paths for every script in this directory. Sourced, not run.
export WH_CONTAINER="${WH_CONTAINER:-jobmarket-warehouse-dbt}"
export WH_HOST="${WH_HOST:-127.0.0.1}"
export WH_PORT="${WH_PORT:-55439}"
export WH_USER="${WH_USER:-warehouse}"
export WH_PASSWORD="${WH_PASSWORD:-warehouse}"
export WH_DB="${WH_DB:-jobmarket_wh}"
# Resolve the project root by walking up for dbt_project.yml, starting at this
# file's own directory when we can see it. Walking up from $PWD alone meant that
# `bash warehouse/scripts/demonstrate.sh` run from the repository root - which is
# how you would naturally invoke it - found nothing and left WH_ROOT empty, so
# every path built from it came out as "/scripts/...". BASH_SOURCE is unset when
# this file is sourced by hand from zsh, which is what the $PWD fallback is for.
_wh_find_root() {
  local start="${WH_ROOT:-}"
  if [ -z "$start" ] && [ -n "${BASH_SOURCE[0]:-}" ]; then
    start="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  fi
  local d="${start:-$PWD}"
  while [ "$d" != "/" ]; do
    [ -f "$d/dbt_project.yml" ] && { echo "$d"; return; }
    d="$(dirname "$d")"
  done
  echo "warehouse: no dbt_project.yml at or above ${start:-$PWD}; set WH_ROOT to the warehouse directory" >&2
}
export WH_ROOT="$(_wh_find_root)"
[ -n "$WH_ROOT" ] || return 1
# scripts/venv.sh builds this. It used to default into ../.agent-work/, a
# personal working directory that is in a global gitignore, so a clone never
# had one and every script here died on a missing binary.
export DBT_BIN="${DBT_BIN:-$WH_ROOT/.venv/bin/dbt}"
export DBT_PROFILES_DIR="$WH_ROOT"

psqlq() { docker exec -i "$WH_CONTAINER" psql -v ON_ERROR_STOP=1 -U "$WH_USER" -d "$WH_DB" "$@"; }
dbtrun() { (cd "$WH_ROOT" && "$DBT_BIN" "$@"); }
