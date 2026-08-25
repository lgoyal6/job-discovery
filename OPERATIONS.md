# Operations runbook

## Routine checks

```bash
docker compose ps
docker compose logs --since=4h n8n postgres
docker compose exec -T postgres pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"
```

Railway deployment checks:

```bash
railway service status --service n8n --json
railway logs --deployment --latest --lines 100 --json --service n8n
```

Each successful cloud start must contain an `ok: true` migration record, the structured `job_pipeline_migrations_complete` event, `n8n ready on 0.0.0.0, port 5678`, and a successful `/healthz` deployment event. PostgreSQL remains private; do not add a TCP proxy solely for routine administration.

### One-time workflow import

After creating the first n8n owner account, set `N8N_IMPORT_WORKFLOWS_ON_START=true` on the n8n service and deploy. Confirm one `n8n_workflow_import_complete` log record for each stable workflow ID the guard imports (`LakshJobDiscovery2h`, `LakshRezzyShortlist`, `FinanceJobDigest6h` and `LakshMarkApplied`), then set the variable back to `false`. `LakshJobDiscoveryErrorAlert` is imported outside the guard and so logs its own record on every deploy. The n8n CLI assigns imports to the owner's personal project, upserts by workflow ID, and forces them inactive. Never leave the switch enabled during routine deploys because imports intentionally deactivate existing matching workflows.

Recent source health:

```sql
SELECT source_name, status, fetched_count, accepted_count, rejected_count,
       duration_ms, cost_units, error_message, finished_at
FROM source_runs
ORDER BY started_at DESC
LIMIT 50;
```

Delivery state:

```sql
SELECT batch_key, status, cardinality(job_ids) AS jobs, claimed_at, sent_at, provider_message_id
FROM email_batches
ORDER BY claimed_at DESC
LIMIT 20;
```

The expected steady state is no overlapping runs, no repeated digest hash, no `UNSUPPORTED` open job with `sent_at`, and zero Notion writes (the codebase contains only `/query` for Notion).

## Overrides

Normalize values to lowercase words before inserting aliases:

```sql
INSERT INTO company_aliases(alias_normalized, canonical_company)
VALUES ('github', 'Microsoft')
ON CONFLICT(alias_normalized) DO UPDATE SET canonical_company=excluded.canonical_company;
```

Sponsorship overrides require job-specific evidence and either a source job ID or canonical URL:

```sql
INSERT INTO sponsorship_overrides(company_normalized, source_job_id, status, evidence, expires_at)
VALUES ('example company', 'REQ-123', 'SUPPORTED', 'Recruiting page explicitly supports F-1 CPT and future sponsorship.', '2027-12-31');
```

Avoid permanent company-wide assumptions: the schema intentionally requires job ID or URL because policy can vary by requisition.

## Failure playbooks

### Notion unavailable

The run reports degraded coverage and uses `applied_exclusions` from the last successful sync. Confirm token validity and that the integration still has read access. A failed or missing-token run never deletes the cache.

### Source failing

Check `error_message`, endpoint health, and the recorded duration. Schema errors are intentional fail-closed behavior for that source. Update its adapter/fixture before accepting a changed payload. Other sources continue.

### Gmail failed after batch claim

Search Gmail by the exact subject and timestamp. If it exists, run `node dist/cli.js batch-sent --batch-key 'KEY' --message-id 'ID'`. If it does not exist, mark the batch `ABANDONED` only after confirming non-delivery, then clear no job timestamps - the jobs were never marked sent. The same digest may then be claimed again.

### Pipeline reports overlap

Inspect running n8n executions and PostgreSQL sessions. The advisory lock releases automatically when its connection closes. Do not terminate a healthy source run just because a second schedule tick skipped.

### Database restore

Stop n8n, restore PostgreSQL, confirm migrations, then start n8n. Preserve the n8n volume and exact encryption key. Run fixture dry-run and a no-email persistent run before reactivation.

## Cost control

Keep Apify disabled during debugging. Actor IDs, input contracts, and prices can change independently. Before enabling the Free-plan coverage, review each actor in Apify, keep the 24-hour cadence and board-specific caps, run exactly once manually, and inspect actual usage. Do not add a payment method or upgrade the Apify account when zero cash spend is required; the Free plan blocks further runs after its allowance is exhausted. Rezzy remains disconnected from scheduled discovery regardless of these settings.
