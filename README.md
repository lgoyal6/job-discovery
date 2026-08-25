# job-discovery

Finds early-career roles that are actually open to you, and mails them once.

It reads 450+ employer job boards, 20 community-maintained lists and LinkedIn's
guest search, then filters roughly 51,000 postings a run down to about 130 that
are genuinely new, genuinely early-career, and genuinely in the United States.
One requisition becomes one row in one email, however many sources found it.

Two readers are served from the same code. The **technical** profile looks for
software, data and hardware internships and new-grad roles. The **finance**
profile looks for investment management, equity research, private and public
markets, quant trading and corporate finance, and deliberately excludes
commercial banking. They run separately, against separate databases, so one
reader's send history never suppresses the other's mail.

## What it does on a run

1. **Fetch** every configured source concurrently, with per-source timeouts,
   retries and health metrics. A source that fails is reported, not fatal.
2. **Classify** each posting: role category, recruiting cycle, graduation
   window, US work eligibility, and whether the posting states a sponsorship
   policy. Every rejection carries a reason, so the funnel is auditable.
3. **Resolve identity** across sources. The same job found on a company's
   Greenhouse board, a GitHub list and LinkedIn is one requisition, matched on
   canonical URL, requisition id, and a normalised title signature.
4. **Rank and cap**, dealing one row per employer per round so a single company
   with nineteen locations cannot consume the whole digest.
5. **Send exactly once**, claiming a batch under a Postgres advisory lock and
   confirming it only after delivery.

## The pipeline

```mermaid
flowchart TD
  S1[("450+ employer boards")] --> F["fetch<br/>concurrent, per-source timeouts,<br/>retries and health metrics"]
  S2[("20 community lists")] --> F
  S3[("LinkedIn guest search")] --> F
  F --> N["~51,000 postings per run"]
  N --> C["classify<br/>role category, cycle, graduation window,<br/>US eligibility, sponsorship policy"]
  C -->|"every rejection carries a reason"| FUNNEL[("auditable funnel")]
  C --> ID["resolve identity across sources<br/>canonical URL, requisition id,<br/>normalised title signature"]
  ID --> ONE["one requisition = one row,<br/>however many sources found it"]
  ONE --> RANK["rank and cap<br/>one row per employer per round"]
  RANK --> SEND{"claim batch under a<br/>Postgres advisory lock"}
  SEND -->|"delivered"| CONFIRM["mark sent"]
  SEND -->|"delivery failed"| RETRY["batch stays unclaimed"]
  CONFIRM --> MAIL["~130 genuinely new roles, one email"]

  style SEND fill:#1f6feb,color:#fff
```

A source that fails is reported, not fatal. The send is confirmed only after
delivery, which is what makes "exactly once" true rather than aspirational.

## Running it

Requires Node 22+ and Postgres.

```bash
npm install
npm run build
npm run test:unit

# Fetch every free source and render a digest without sending or storing anything
node dist/cli.js dry-run --live-free

# The real thing: stores, dedupes against send history, prepares a batch
node dist/cli.js pipeline
```

`JOB_PROFILE=finance` switches profiles. `config/` holds the sources, the
company aliases and the sponsorship patterns; `migrations/` holds ordered,
idempotent SQL that is safe to re-run.

## Deploying it

The pipeline runs on a schedule under n8n, with Postgres for send history.

```bash
# local or a single box
docker compose up -d            # postgres, migrate, n8n
docker compose ps
docker compose logs --since=4h n8n postgres
```

For a hosted run, `railway.json` builds `Dockerfile.n8n` with a `/healthz`
check and `restartPolicyType: ALWAYS`:

```bash
railway up
railway service status --service n8n --json
```

Migrations in `migrations/` are ordered and idempotent, so they are safe to
re-run; a healthy start logs a `job_pipeline_migrations_complete` event. Keep
Postgres private, and leave `N8N_IMPORT_WORKFLOWS_ON_START` off except for the
one-time workflow import. Full runbook, including source-health triage, is in
[OPERATIONS.md](OPERATIONS.md).

## Contributing

The most useful contribution is a job board we do not read yet. See
[CONTRIBUTING.md](CONTRIBUTING.md) for how to find one, how to verify it is
really the company it claims to be, and how to add it.

Issues labelled `good first issue` are real gaps with a reproduction attached.

## Licence

MIT. See [LICENSE](LICENSE).
