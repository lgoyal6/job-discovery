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

Every two hours, n8n invokes the compiled Node CLI. The CLI acquires a PostgreSQL advisory lock, fetches sources with bounded retries/timeouts and bounded concurrency, validates responses, applies deterministic rules, reads Notion applied exclusions, canonicalizes and merges jobs, persists state, and atomically claims a digest batch. n8n sends Gmail only when `shouldSend=true`, then confirms the batch so the included jobs receive `sent_at`.

Not every source runs on every tick. LinkedIn runs twice a day, the Apify actors once, and the Greenhouse boards every six hours because they are the only ones that answer with full descriptions: about 300 MB a pass, against roughly 3 MB for the listings alone. That description is what gives a Greenhouse posting a cycle, a sponsorship verdict and a skills list, so without it a title lacking a year was simply dropped. Descriptions are kept only for student-titled postings, which is what keeps 17,716 of them from reaching memory.

A LinkedIn query may set its own paging depth. The default of five pages was measured against the technical searches, where relevance decays sharply with depth; the finance searches do not behave that way, and five pages was discarding about half of every one of them (79 distinct postings for "equity research internship" in a 24-hour window, 98 for "investment analyst intern", 63 for "private equity internship"). Ten finance queries at eight pages then earned a 429 partway through a run, because the guest endpoint rate-limits per address rather than per search and the source pool runs four queries at once, so two queries returned nothing at all. Every LinkedIn request in the run, enrichment's included, now goes through one gate that holds the inter-request delay, which took the run from 140 postings and a throttle to 723 postings and none. A query that yields 50 rows every run is worth more than one that yields 100 sometimes and 0 otherwise.

The two intern-list sources run every six hours for the same reason. Their rows are in the markup, a Webflow collection of 254 and 251 postings across three pages, but the list page carries no location and no prose, so every row whose title names a cycle costs a second request to the posting's own page: 186 of them a pass. A row that names no cycle is not fetched, because that page never names one either. A row whose page could not be read is dropped rather than emitted without its location, since `materialFingerprint` is the title, the location and the cycle, and a location that appears on one run and not the next clears `sent_at` and mails the role again. The site holds a rolling three-month window and drops closed roles rather than flagging them, so a closure arrives as the 72-hour stale threshold rather than as a status on the page.

A second digest runs out of the same code for a second reader. `JOB_PROFILE=finance` swaps four things at once: the source list (one finance list, seven LinkedIn searches named after the roles that reader asked for, and 38 ATS boards rather than the 151 technical ones, with no Apify actors, watched program pages or applied ledger), the role rules, the recipient via `FINANCE_EMAIL_TO`, and the database via `FINANCE_DATABASE_URL`. Boards and LinkedIn queries carry the profile they belong to and are filtered as they load; a board marked `both`, which is every trading firm and investment manager on the list, is fetched by either digest. Its own database is not a preference: `jobs.sent_at` is one column and `email_batches` carries no recipient, so two profiles against one database would mean the second reader never sees a role the first was mailed, and `pipeline` refuses to start without it. With `JOB_PROFILE` unset the run is byte-identical to what it was before the profile existed.

The finance digest has its own Apify account, and it runs exactly one paid actor. Every actor in the set is priced per event, and the arithmetic decides which is usable on a free plan's $5 a month: Monster charges $0.001 a result, so 120 results once a day is $3.72, while the Indeed actor charges $0.50 per search plus $0.01 per described job and one run of a few hundred rows spends the month. The LinkedIn actor would buy a fifth copy of what the guest endpoint already returns 723 of, for money. `FINANCE_APIFY_TOKEN` has no fallback to `APIFY_TOKEN` for the same reason the recipient has none: the credit does not roll over and the account blocks for the rest of the cycle once it is spent, so a shared token would let one digest take the other's paid sources down with it. The search wording matters more than the source. Measured on Monster at 150 results, "finance internship summer 2027" returned 87 rows the finance rules accept, 84 of them internships, none from a staffing agency, and 18 carrying a sponsorship policy readable off the description; "investment analyst intern 2027" returned four out of ten on the same actor and the rest were senior FP&A roles.

The finance rules keep what that reader asked for and nothing adjacent to it: investment and asset management, wealth management, private and public markets, equity research, investment banking and M&A, and plain finance internships. Order is the whole design, because these families share vocabulary. Seniority, commercial banking and back-office operations are rejected first, before any front-office pattern, because "Commercial Banking Intern" contains "banking intern" and "Summer Analyst, Operations" contains "summer analyst"; the commercial pattern requires its two words adjacent so JPMorgan's "Commercial & Investment Bank, Markets Equity Research" survives it. Accounting, insurance, risk and another discipline entirely are rejected after the front office, because there the overlap runs the other way: "Investment Banking, Tax Advisory", "Credit and Insurance, Private Credit Strategies Summer Analyst" and "Equity Capital Markets Underwriting" all have to survive. Corporate finance is tested last of all, which is what lets it end in a bare "finance" and still catch "Intern, Finance (Summer 2027)". A cycle is not required, because internships name one and full-time analyst roles name nothing and both are wanted; the graduation filter is off, because `classifyGraduation` encodes one candidate's June 2028 window and this digest is not theirs. Seniority does the work those two cannot: whole employer boards are read now, and BlackRock's is 250 postings of which two are internships. A role must also show positive evidence of being open to a student or a new graduate, which is a filter this profile needs and the technical one does not: `STUDENT_ROLE` and the cycle requirement are off here so that a full-time new-grad analyst role survives, and seniority only rejects the top end, so between the two sat Vanguard's "Certified Financial Advisor" and Morgan Stanley's "Private Wealth Management Investment Consultant", which name no seniority, no cycle, and want years behind them. A title naming an internship, a graduate programme or an entry-level role qualifies, as does an analyst or associate title carrying its class year; a stated requirement of two years' experience or more disqualifies. It is deliberately strict and it does cost real entry-level rows whose posting never says so, because a LinkedIn card carries no description at the point this runs. It rejects 484 rows a pass. The email is three sections, in this order: Investing, Corporate finance, and the roles that state a sponsorship or citizenship requirement, carried last so nothing found is silently dropped. Rows are newest first, with score breaking a tie. A live pass reads 4,646 rows and finds 875 eligible, mailing 106 requisitions a run and draining the rest over the following ticks. The cap ranks by the same order the email prints in, which is what makes "newest first" more than cosmetic: ranking the cap by score and the email by date meant a role posted this morning lost its place to a better-scoring one from three weeks ago and never appeared at all.

Sponsorship is not a rejection. A posting whose own text says it cannot sponsor is carried through and reported in a separate, separately capped digest section, because the sentence is boilerplate that employers do depart from and the judgement belongs to the reader. An ITAR or US-person requirement lands in the same section and is a legal bar rather than a policy; the evidence line on each row is what tells them apart.

The Railway image uses `scripts/railway-entrypoint.sh` to apply the ordered, idempotent pipeline migrations before starting n8n. It emits a structured `job_pipeline_migrations_complete` marker, then Railway checks `/healthz` on `PORT=5678`. This avoids a separate pre-deploy container while preserving private-network database access and observable migration failure. After the n8n owner account exists, set `N8N_IMPORT_WORKFLOWS_ON_START=true` for one deployment to import the version-controlled workflows. Imports target the owner's personal project, upsert their stable IDs, and remain inactive. Set the switch back to `false` immediately after the `n8n_workflow_import_complete` log markers appear.

An import overwrites a workflow that already exists, and the exported JSON deliberately carries no credentials and `active: false`. So importing over a running schedule deactivates it and drops its Gmail credential reference, and the digest stops without failing: the workflow simply never fires again. Verified the hard way, on a schedule that had run at 11:07, 13:07, 15:07 and 17:07 that day. The credential itself survives in n8n's encrypted store; only the node's reference to it is gone. After any import, re-attach the credential on each Gmail node and switch the schedule back on, then confirm from `execution_entity` that it fired.

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

### Adding a board

`config/sources.json` is a whitelist, so the pipeline sees exactly what it is told to and nothing else. `npm run build && node dist/cli.js discover-boards` probes unconfigured watchlist companies, but only for Greenhouse, Lever and Ashby, because those are the only three whose slug can be guessed from a company name. It reported 0 new boards from 239 companies, and it was right: what remains is the Workday, Oracle, iCIMS and Taleo tier, which it does not probe.

An Oracle Recruiting company needs its pod host and site number, both visible in any posting URL on its careers site:

```json
{ "type": "oracle", "host": "https://egug.fa.us2.oraclecloud.com", "site": "CX_1", "company": "American Express" }
```

American Express serves that pod behind `careers.americanexpress.com`, which proxies the posting pages but not the API, so the pod host is the one that works.

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
