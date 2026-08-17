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

  # Imported inactive like the others, then activated on its own line, because
  # --activeState takes only "false" or "fromJson" and this script runs under
  # set -eu: a rejected flag value stops the container from ever starting n8n.
  #
  # Active, unlike the other two, because a webhook that is not active answers
  # 404 and the Mark applied link in every digest row would be dead. It is safe
  # active: it refuses anything without a valid HMAC of a job id, and refuses
  # everything at all while MARK_APPLIED_SECRET is unset.
  n8n import:workflow --input=/opt/job-pipeline/workflows/mark-applied-webhook.json --activeState=false
  n8n update:workflow --id=LakshMarkApplied --active=true
  printf '%s\n' '{"level":"info","event":"n8n_workflow_import_complete","workflow_id":"LakshMarkApplied","active":true}'
fi

cd /home/node
exec n8n "$@"
