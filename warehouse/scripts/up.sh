#!/usr/bin/env bash
# Start the Postgres every other script in this directory talks to. Idempotent:
# creates the container if it is missing, starts it if it is stopped, and waits
# until it actually answers before returning. demonstrate.sh calls it for you.
#
# This is a plain `docker run` rather than a service in the repository root
# docker-compose.yml on purpose. That stack is the operational pipeline: it
# wants a .env with real secrets and it brings up n8n. The warehouse demo needs
# one throwaway Postgres on its own port and nothing else, so it gets its own
# container with no volume, and scripts/down.sh removes every trace of it.
set -euo pipefail
source "$(dirname "$0")/env.sh"

IMAGE="${WH_IMAGE:-postgres:16-alpine}"

if ! docker info >/dev/null 2>&1; then
  echo "warehouse: docker is not running. Start Docker Desktop and try again." >&2
  exit 1
fi

if [ -n "$(docker ps -aq -f "name=^${WH_CONTAINER}$")" ]; then
  if [ -z "$(docker ps -q -f "name=^${WH_CONTAINER}$")" ]; then
    echo "starting existing container ${WH_CONTAINER}"
    docker start "$WH_CONTAINER" >/dev/null
  else
    echo "container ${WH_CONTAINER} already running"
  fi
else
  echo "creating container ${WH_CONTAINER} (${IMAGE}) on ${WH_HOST}:${WH_PORT}"
  docker run -d --name "$WH_CONTAINER" \
    -e POSTGRES_USER="$WH_USER" \
    -e POSTGRES_PASSWORD="$WH_PASSWORD" \
    -e POSTGRES_DB="$WH_DB" \
    -p "${WH_HOST}:${WH_PORT}:5432" \
    "$IMAGE" >/dev/null
fi

# pg_isready against the socket inside the container, because that is how every
# other script here reaches it. A published port that is listening is not the
# same thing as a database that will accept a connection.
printf 'waiting for postgres'
for _ in $(seq 1 60); do
  if docker exec "$WH_CONTAINER" pg_isready -q -U "$WH_USER" -d "$WH_DB" 2>/dev/null; then
    echo " ready"
    exit 0
  fi
  printf '.'
  sleep 1
done
echo
echo "warehouse: ${WH_CONTAINER} did not become ready within 60s" >&2
docker logs --tail 20 "$WH_CONTAINER" >&2 || true
exit 1
