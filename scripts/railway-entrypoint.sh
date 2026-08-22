#!/bin/sh
set -eu

cd /opt/job-pipeline
node dist/cli.js migrate
sleep 1
printf '%s\n' '{"level":"info","event":"job_pipeline_migrations_complete"}'

# The finance digest keeps its own database, so it needs the same ordered
# migrations applied to it or the next one to land will reach only one of the
# two. Both variables, because JOB_PROFILE=finance refuses to start without a
# recipient of its own, and skipped entirely when the profile is not configured.
if [ -n "${FINANCE_DATABASE_URL:-}" ] && [ -n "${FINANCE_EMAIL_TO:-}" ]; then
  JOB_PROFILE=finance node dist/cli.js migrate
  sleep 1
  printf '%s\n' '{"level":"info","event":"job_pipeline_migrations_complete","profile":"finance"}'
fi

if [ "${N8N_IMPORT_WORKFLOWS_ON_START:-false}" = "true" ]; then
  n8n import:workflow --input=/opt/job-pipeline/workflows/job-discovery-every-two-hours.json --activeState=false
  printf '%s\n' '{"level":"info","event":"n8n_workflow_import_complete","workflow_id":"LakshJobDiscovery2h","active":false}'

  n8n import:workflow --input=/opt/job-pipeline/workflows/rezzy-shortlist-webhook.json --activeState=false
  printf '%s\n' '{"level":"info","event":"n8n_workflow_import_complete","workflow_id":"LakshRezzyShortlist","active":false}'

  # Inactive like the schedule above it. SEND_EMAIL_ENABLED is true in
  # production, so activating this one mails a real person: that belongs in the
  # UI, deliberately, not in a deploy.
  n8n import:workflow --input=/opt/job-pipeline/workflows/finance-digest-every-six-hours.json --activeState=false
  printf '%s\n' '{"level":"info","event":"n8n_workflow_import_complete","workflow_id":"FinanceJobDigest6h","active":false}'

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

# Outside the guard above, and deliberately. That guard is off in production,
# because importing the schedules would arrive with --activeState=false and
# switch off live digests; nothing has imported any workflow on deploy for
# months, which is how the copy of the failure alert running in n8n came to
# differ from the one in this repository. It differed in the way that mattered:
# its Discord message embedded the pipeline's whole stderr, 10,933 characters on
# a real failure against a 4,000 character limit, so every alert was rejected
# with "Invalid Form Body" and eighteen hours of failed runs announced nothing.
#
# Importing this one is safe where importing the schedules is not: it mails
# nobody, it starts nothing on a timer, and it has to match this repository or
# the next silent failure is the same failure. Activated on its own line because
# --activeState takes only "false" or "fromJson".
#
# Non-fatal, unlike the guarded block, which runs under set -eu: this script
# stands between the image and n8n starting at all, and an auxiliary workflow
# failing to import must never be the reason the container does not boot. The
# failure is printed rather than swallowed, because a silent alerting failure is
# the thing this whole change is about.
if n8n import:workflow --input=/opt/job-pipeline/workflows/job-discovery-error-alert.json --activeState=false \
  && n8n update:workflow --id=LakshJobDiscoveryErrorAlert --active=true; then
  printf '%s\n' '{"level":"info","event":"n8n_workflow_import_complete","workflow_id":"LakshJobDiscoveryErrorAlert","active":true}'
else
  printf '%s\n' '{"level":"error","event":"n8n_workflow_import_failed","workflow_id":"LakshJobDiscoveryErrorAlert"}'
fi

cd /home/node
exec n8n "$@"
