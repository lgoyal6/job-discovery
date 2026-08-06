#!/bin/sh
set -eu

cd /opt/job-pipeline
node dist/cli.js migrate
sleep 1
printf '%s\n' '{"level":"info","event":"job_pipeline_migrations_complete"}'

if [ "${N8N_IMPORT_WORKFLOWS_ON_START:-false}" = "true" ]; then
  n8n import:workflow --input=/opt/job-pipeline/workflows/job-discovery-every-two-hours.json --activeState=false
  printf '%s\n' '{"level":"info","event":"n8n_workflow_import_complete","workflow_id":"LakshJobDiscovery2h","active":false}'

  n8n import:workflow --input=/opt/job-pipeline/workflows/rezzy-shortlist-webhook.json --activeState=false
  printf '%s\n' '{"level":"info","event":"n8n_workflow_import_complete","workflow_id":"LakshRezzyShortlist","active":false}'
fi

cd /home/node
exec n8n "$@"
