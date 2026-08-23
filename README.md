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

## Contributing

The most useful contribution is a job board we do not read yet. See
[CONTRIBUTING.md](CONTRIBUTING.md) for how to find one, how to verify it is
really the company it claims to be, and how to add it.

Issues labelled `good first issue` are real gaps with a reproduction attached.

## Licence

MIT. See [LICENSE](LICENSE).
