# Laksh Job Discovery

Deterministic, self-hosted job discovery for Laksh Goyal. n8n schedules the run and sends a Gmail digest; a TypeScript package owns ingestion, validation, filtering, scoring, deduplication, state, and rendering. PostgreSQL is the system of record. No LLM API is used at runtime.

The existing Codex automation and both files in `../automation/` are untouched. The watchlist is mounted read-only into the n8n image. Notion is read-only during discovery unless the opt-in posting mirror is enabled; both writes it can perform are described below.

## Safety defaults

- `SEND_EMAIL_ENABLED=false`: the pipeline cannot claim a Gmail batch and n8n cannot reach the Gmail node.
- `APIFY_ENABLED=false`: no Apify actor can run during development. In production it may be enabled against Apify's hard-capped Free plan without adding a payment method.
- `npm run dry-run`: fixture-only; no network, database, credentials, email, Notion, Rezzy, or paid API.
- `npm run dry-run:live`: free public sources only; no database, credentials, email, Notion, Rezzy, or paid API.
- Both exported workflows are inactive. Rezzy is a separate manual webhook and returns `rezzy_disabled` when its credentials are absent.
- Notion writes are gated and off by default. `NOTION_MIRROR_ENABLED=false` means a run only queries the ledger and reports `notionModified: false`; `MARK_APPLIED_SECRET` and `MARK_APPLIED_BASE_URL` are both empty, which renders no link and makes the webhook refuse every request. There is no archive or delete implementation, and the only update is a status change on a page this pipeline created.

## Architecture

Every two hours, n8n invokes the compiled Node CLI. The CLI acquires a PostgreSQL advisory lock, fetches sources independently with bounded retries/timeouts, validates responses, applies deterministic rules, reads Notion applied exclusions, canonicalizes and merges jobs, persists state, and atomically claims a digest batch. n8n sends Gmail only when `shouldSend=true`, then confirms the batch so the included jobs receive `sent_at`.

The Railway image uses `scripts/railway-entrypoint.sh` to apply the ordered, idempotent pipeline migrations before starting n8n. It emits a structured `job_pipeline_migrations_complete` marker, then Railway checks `/healthz` on `PORT=5678`. This avoids a separate pre-deploy container while preserving private-network database access and observable migration failure. After the n8n owner account exists, set `N8N_IMPORT_WORKFLOWS_ON_START=true` for one deployment to import both version-controlled workflows. Imports target the owner's personal project, upsert their stable IDs, and remain inactive. Set the switch back to `false` immediately after the two `n8n_workflow_import_complete` log markers appear.

The database contains `jobs`, `job_sources`, `source_runs`, `email_batches`, `watchlist_states`, `company_aliases`, `sponsorship_overrides`, `pipeline_watermarks`, `applied_exclusions`, and `schema_migrations`. A 72-hour stale-source threshold closes jobs conservatively. A reopen only clears `sent_at` and increments `material_version` if the role was gone for more than 30 days, because "closed" here means "absent from a capped, rotating scrape" and a shorter gap is sampling rather than a repost. A material change to the title signature, canonicalized location, or cycle does the same; the apply URL does not, and neither does a second list wording the title or spelling the city differently. A requisition already emailed under one row is suppressed if it later arrives as another.

## Quick start

Requirements: Docker Desktop/Engine with Compose v2, or Node.js 22+ for host-only tests.

```bash
cd "/Users/lakshgoyal/Documents/New project/job-discovery"
cp .env.example .env
```

Set strong random values for `POSTGRES_PASSWORD`, `N8N_ENCRYPTION_KEY`, and `N8N_USER_MANAGEMENT_JWT_SECRET`. Keep both safety gates false. Then:

```bash
npm ci
npm test
npm run lint
npm run typecheck
npm run dry-run
npm run dry-run:live
docker compose config --quiet
docker compose up --build -d
docker compose exec -T n8n n8n import:workflow --input=/opt/job-pipeline/workflows/job-discovery-every-two-hours.json
docker compose exec -T n8n n8n import:workflow --input=/opt/job-pipeline/workflows/rezzy-shortlist-webhook.json
```

n8n is available only on the loopback interface at [http://localhost:5678](http://localhost:5678). Create the owner account on first launch. Both workflows import inactive.

### Railway

Deploy from the repository parent so `railway.json`, `.railwayignore`, the watchlist, and `job-discovery/Dockerfile.n8n` are all included:

```bash
cd "/Users/lakshgoyal/Documents/New project"
railway up --service n8n --ci
railway service status --service n8n --json
```

Set both `PORT=5678` and `N8N_PORT=5678`. The n8n service references the Postgres service through Railway private-network variables; PostgreSQL does not need a public TCP proxy. Keep `SEND_EMAIL_ENABLED=false`, `APIFY_ENABLED=false`, `PAID_SOURCES_ENABLED=false`, and normally `N8N_IMPORT_WORKFLOWS_ON_START=false`. A public Railway domain is required only for the authenticated editor and Gmail OAuth callback; generate it after the private deployment is healthy and create the owner account immediately. To bootstrap the workflows after owner creation, set the import switch to `true`, wait for both structured import markers, then restore it to `false`.

## Credentials

### Notion

Create an internal integration, share the applied ledger with it, and set `NOTION_TOKEN`. Read-content access is all the default configuration needs; the two opt-in writes below need insert and update as well. The database/data-source IDs are already the supplied IDs. If the token is missing or a read fails, the run uses the last successful PostgreSQL exclusion cache and reports degraded coverage; it never clears that cache on failure.

### Mirroring postings into the ledger

`NOTION_MIRROR_ENABLED=true` writes a Notion page for every newly persisted eligible role, under `NOTION_MIRROR_STATUS` (default `New`). The applied read filters on `Status = Applied`, so a mirrored posting is a record rather than an exclusion; startup fails if the two are set to the same value.

The cost this carries, and what bounds it:

- Notion allows roughly three requests a second, so writes are serial and paced at 350ms. A run mirrors at most `NOTION_MIRROR_MAX_PER_RUN` (default 200) and a backlog drains over later runs.
- It runs last in the pipeline, after the email batch is claimed, so it never delays the digest.
- Each role is written once. Its page id is stored on the job, so later runs skip it and `Mark applied` moves that page to `Applied` instead of filing a second row beside it.
- It never throws. A workspace that is down, rate limiting, or missing its integration costs the run its mirror and nothing else, and five consecutive failures with no success abandons the batch until the next run.

The integration needs insert- and update-content capability for this. A run that mirrored anything reports `notionModified: true`.

### Mark applied from the digest

Each role in the digest can carry a `Mark applied` link. Following it files that role in the Notion ledger with `Status = Applied`, which is the same row the next run reads back as an exclusion, so the role stops appearing. It is off until both values are set:

```bash
openssl rand -hex 32          # MARK_APPLIED_SECRET
# MARK_APPLIED_BASE_URL=https://<n8n public domain>/webhook/mark-applied
```

Turning it on also means adding insert-content capability to the Notion integration, which is the only reason this project ever writes to the workspace. Then import the workflow and activate only this one:

```bash
docker compose exec -T n8n n8n import:workflow --input=/opt/job-pipeline/workflows/mark-applied-webhook.json
```

The link carries the job id and an HMAC of it, so a guessed id files nothing. The webhook accepts only a uuid and a 32-character hex digest, rejecting anything else before the value reaches a shell. A row already in the ledger is reported as success and written once, so a re-clicked link, or a mail client that scans links on its own, cannot create duplicates. The ledger's own schema decides the payload, so the role lands in whichever property the reader looks for (`Role`/`Title`/`Name`) rather than a guessed column.

### Gmail in n8n

In n8n, create a Gmail OAuth2 credential and select it in `Send Gmail Digest`. The workflow intentionally exports without a credential ID. Use the Google OAuth redirect URL displayed by n8n and authorize the mailbox that will send to the address in `EMAIL_TO`. Leave the workflow inactive and `SEND_EMAIL_ENABLED=false` until the controlled live-send test is explicitly approved.

### Apify

Set `APIFY_TOKEN` to retain independent LinkedIn, Indeed, and Monster coverage through Apify's Free plan. Defaults are configurable and currently point to:

- LinkedIn: `curious_coder/linkedin-jobs-scraper`
- Indeed: `schnellscrapers/indeed-jobs-scraper`
- Monster: `axlymxp/monster-scraper`

The actors are third-party community software, so review their current schemas, terms, health, and pricing before enabling. Apify's Free plan currently provides $5 of monthly platform usage, requires no card, and blocks further service access when that allowance is exhausted. The pipeline still runs every two hours, but PostgreSQL watermarks limit each board actor to once every 24 hours. Defaults cap LinkedIn at 35 results/day, Indeed at 15, and Monster at 35. At current listed per-result prices this targets about $3.45/month before incidental platform usage, leaving headroom under the free allowance. Safeguards also include `maxTotalChargeUsd`, actor timeouts, `APIFY_ENABLED`, and the legacy `PAID_SOURCES_ENABLED` kill switch. Never log the token.

### Rezzy

Set `REZZY_API_KEY`, `REZZY_PROFILE_ID`, `REZZY_WEBHOOK_SECRET`, and, if the vendor contract differs, `REZZY_API_BASE_URL`/`REZZY_DRAFT_PATH`. The endpoint is manual-only. It accepts a POST with an `x-rezzy-webhook-secret` header, at least a 50-character `jobDescription`, and optional `jobTitle`, `company`, and `companyUrl`. The current Rezzy API uses the profile associated with the API key; `REZZY_PROFILE_ID` remains a required local safety check so a draft cannot run before a profile is intentionally selected. It is not connected to discovery and never runs per candidate.

## Source configuration

`config/sources.json` contains all community feeds and direct ATS boards. Shipped direct sources exercise Greenhouse (Anduril, Five Rings), Lever (Palantir), and Ashby (OpenAI, Notion). Add company-specific public endpoints with these shapes:

```json
{"type":"greenhouse","board":"board-token","company":"Company"}
{"type":"lever","site":"site-token","company":"Company"}
{"type":"ashby","board":"board-name","company":"Company"}
{"type":"smartrecruiters","companyId":"identifier","company":"Company"}
{"type":"workday","host":"https://company.wd5.myworkdayjobs.com","tenant":"tenant","site":"External","company":"Company"}
{"type":"icims","company":"Company","endpoint":"https://public-json-endpoint"}
```

The same generic endpoint form supports `oracle`, `successfactors`, `eightfold`, and `career-page`. External response schemas are validated for the structured adapters. Greenhouse/Ashby return complete board snapshots; Lever, SmartRecruiters, and Workday paginate up to `ATS_MAX_RESULTS_PER_SOURCE`.

The Markdown watchlist is parsed into parent/subsidiary groups. A deterministic two-hour cohort rotates all 338 normalized employers while Tier A and San Diego employers receive higher ranking and more frequent placement. The current cohort is recorded in `source_runs.metrics`; when LinkedIn Apify coverage is enabled, those names are included in its search URLs.

## Deterministic rules

- Category order: ML/AI, Quant, GTM engineering, then SWE. Generic “engineering,” “technology,” and “all tracks” titles are rejected unless the title or description contains an allowed technical signal.
- Explicit title/description cycle text overrides feed hints. Priority is Summer 2027, Fall 2026, Winter 2027, Spring 2027, then later compatible programs.
- A 2027 new-grad role is rejected unless its graduation window explicitly includes 2028. Internships without an excluding graduation clause remain eligible.
- `UNSUPPORTED` is evaluated before `SUPPORTED`, preventing mixed text from being accepted. Unknown authorization wording remains `UNKNOWN` and is emailed in its own section.
- Patterns live in `config/sponsorship-patterns.yaml`. Per-job overrides live in PostgreSQL `sponsorship_overrides`; company aliases may be added to `company_aliases` without a code deploy.
- Canonical identity uses source+job ID first, then tracking-free direct URL, then normalized company/title/location/cycle. Cross-source URL/tuple merging keeps materially different locations separate.

## Commands

```bash
npm test                 # unit tests; DB integration test skips unless TEST_DATABASE_URL is set
npm run test:unit        # deterministic unit/adapter tests only
npm run test:e2e         # disposable PostgreSQL: migrations + persistence + email-batch handoff
npm run test:all         # unit and complete no-send E2E suites
npm run lint
npm run typecheck
npm run migrate          # apply ordered SQL migrations
npm run dry-run          # fixtures, zero side effects
npm run dry-run:live     # public free sources, zero persistent side effects
npm run pipeline         # persistent production run; Gmail is still gated in n8n
npm run batch:sent -- --batch-key KEY --message-id ID
```

For the PostgreSQL integration test:

```bash
# Use a URL whose host is 127.0.0.1 (the Compose DATABASE_URL uses the
# container-only hostname `postgres`). URL-encode special password characters.
TEST_DATABASE_URL="postgresql://job_pipeline:ENCODED_PASSWORD@127.0.0.1:5432/job_discovery" npm test
```

## First authenticated dry run (no email)

1. Populate `.env` with strong database/n8n secrets and `NOTION_TOKEN`. Keep `SEND_EMAIL_ENABLED=false`, `APIFY_ENABLED=false`, and `PAID_SOURCES_ENABLED=false` for the first pass.
2. Run `docker compose up --build -d` and `docker compose ps`.
3. Import both JSON files with the two CLI commands in Quick start.
4. Open `http://localhost:5678`, create/select the Gmail OAuth2 credential on `Send Gmail Digest`, save, but do not publish/activate the workflow.
5. Run `docker compose exec -T n8n sh -lc 'cd /opt/job-pipeline && node dist/cli.js pipeline'`.
6. Confirm the JSON has `shouldSend:false`, `notionModified:false`, a successful `notion-applied` source, and no unexpected source failures.
7. Inspect `docker compose exec -T postgres sh -lc 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "select source_name,status,fetched_count,accepted_count,rejected_count,error_message from source_runs order by started_at desc limit 20;"'`.
8. Re-run step 5. Existing jobs remain unsent because sending is disabled, but no batch is claimed and no email occurs.
9. For the controlled Apify Free-plan test, add the free-account token, set `APIFY_ENABLED=true`, leave `PAID_SOURCES_ENABLED=false`, recreate n8n, and run once manually. Confirm usage in Apify before leaving the daily cadence enabled.

For the later explicitly approved Gmail end-to-end test: set `SEND_EMAIL_ENABLED=true`, recreate n8n, run the workflow manually once, verify the message at the address in `EMAIL_TO`, verify one `email_batches.status='SENT'` row, then publish the scheduled workflow. Do not publish it before that check.

## Operations and recovery

- Logs are newline-delimited JSON on stderr. The pipeline report alone is JSON on stdout so n8n can parse it.
- One failed source becomes `FAILED` or `SKIPPED`; other sources continue and the digest includes degraded coverage.
- PostgreSQL advisory locking rejects overlap. n8n may retry the command, but only one digest hash can be claimed. Gmail is not retried automatically; confirmation occurs only after Gmail returns success.
- A claimed batch whose Gmail node never ran can be inspected in `email_batches`. After confirming no message exists in Gmail, mark it `ABANDONED` in PostgreSQL; the jobs remain unsent and the same digest can be claimed again. Never mark `SENT` manually without verifying delivery.
- Back up both named volumes. Restore PostgreSQL first, then the n8n volume, using the same `N8N_ENCRYPTION_KEY` or OAuth credentials cannot be decrypted.
- Upgrade the pinned n8n image deliberately, review release notes, rebuild, run the fixture suite, import into a disposable instance, then promote.
- Run `docker compose exec -T n8n n8n audit` periodically. Execute Command and environment access are enabled because these two version-controlled workflows require them; keep n8n loopback-only or behind an authenticated TLS reverse proxy.

See [OPERATIONS.md](OPERATIONS.md) for SQL checks, override examples, and failure playbooks.
