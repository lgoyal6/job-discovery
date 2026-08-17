#!/usr/bin/env bash
set -euo pipefail

container_name="laksh-job-discovery-e2e-postgres"
postgres_port="${E2E_POSTGRES_PORT:-55433}"
database_url="postgresql://job_pipeline:validation-only@127.0.0.1:${postgres_port}/job_discovery"

cleanup() {
  docker stop "${container_name}" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

docker run --rm --detach --name "${container_name}" \
  --tmpfs /var/lib/postgresql/data:rw,noexec,nosuid,size=256m \
  -e POSTGRES_DB=job_discovery \
  -e POSTGRES_USER=job_pipeline \
  -e POSTGRES_PASSWORD=validation-only \
  -p "127.0.0.1:${postgres_port}:5432" \
  postgres:16-alpine >/dev/null

for _ in $(seq 1 30); do
  if docker exec "${container_name}" pg_isready -U job_pipeline -d job_discovery >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
docker exec "${container_name}" pg_isready -U job_pipeline -d job_discovery >/dev/null

npm run build
DATABASE_URL="${database_url}" node dist/cli.js migrate
TEST_DATABASE_URL="${database_url}" npx vitest run \
  --no-file-parallelism \
  tests/db.integration.test.ts tests/e2e.pipeline.test.ts tests/repeat-suppression.test.ts
