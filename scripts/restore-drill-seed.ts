/**
 * Fill an empty database with invented postings, so a restore has something to
 * be a restore of.
 *
 * Every company, title, URL and Notion page id here is made up. None of it is
 * anybody's application history: the drill this feeds must never be pointed at
 * the database the pipeline actually runs against, and seeding from scratch is
 * what makes that easy to keep true.
 *
 * The rows go in through the pipeline's own writers - upsertJob,
 * prepareEmailBatch, markBatchSent, saveEnrichment, recordSourceRuns - rather
 * than through hand written INSERTs, so the normalized columns, the material
 * fingerprint and the send state are whatever the real code produces. That is
 * what lets the invariant check afterwards recompute them and mean something.
 *
 *   DATABASE_URL=... npx tsx scripts/restore-drill-seed.ts 4000
 */
import {
  migrate, pool, upsertJob, prepareEmailBatch, markBatchSent, saveEnrichment,
  recordSourceRuns, syncLedgerExclusions, savePageWatch, newRunId
} from '../src/db.js';
import { canonicalKey, canonicalizeUrl, canonicalLocation, normalizeText } from '../src/normalization.js';
import type { ClassifiedJob, DigestJob } from '../src/types.js';

const COUNT = Number(process.argv[2] ?? 4000);

const COMPANIES = [
  'Aldermoor Systems', 'Bellwether Compute', 'Calder Robotics', 'Deepfield Labs',
  'Everline Trading', 'Fenwick Analytics', 'Grayharbor Networks', 'Halyard Medical',
  'Ironvale Software', 'Juniper Grid', 'Kestrel Instruments', 'Lantern Optics',
  'Marloch Aerospace', 'Northgale Energy', 'Oakhaven Data', 'Pellworth Devices',
  'Quillon Semiconductor', 'Redcliff Payments', 'Stonebrook Cloud', 'Thackery Motors'
];
const TITLES = [
  'Software Engineer Intern', 'Backend Engineer Intern', 'Data Engineer Intern',
  'Machine Learning Intern', 'Platform Engineer Intern', 'Quantitative Developer Intern',
  'Site Reliability Intern', 'Embedded Software Intern'
];
const PLACES = ['Austin, TX', 'Boston, MA', 'Chicago, IL', 'Denver, CO', 'Seattle, WA', 'Remote'];
const SOURCES = ['greenhouse', 'lever', 'ashby', 'smartrecruiters', 'community'];
const CYCLES = ['SUMMER_2027', 'SUMMER_2028'];
const SPONSORSHIP = ['SUPPORTED', 'UNKNOWN', 'UNSUPPORTED'] as const;

function classified(i: number): ClassifiedJob {
  const company = COMPANIES[i % COMPANIES.length]!;
  const title = TITLES[(i >> 2) % TITLES.length]!;
  const location = PLACES[(i >> 1) % PLACES.length]!;
  const sourceName = SOURCES[i % SOURCES.length]!;
  const cycle = CYCLES[i % CYCLES.length]!;
  const sourceJobId = `REQ-${100000 + i}`;
  const sourceUrl = `https://boards.example.invalid/${normalizeText(company).replace(/ /g, '-')}/${sourceJobId}`;
  const canonicalUrl = canonicalizeUrl(sourceUrl);
  const normalizedCompany = normalizeText(company);
  const normalizedTitle = normalizeText(title);
  const normalizedLocation = canonicalLocation(location);
  return {
    sourceName, sourceJobId, title, company, location,
    postedAt: new Date(Date.UTC(2026, 0, 1 + (i % 240))).toISOString(),
    description: `Invented posting ${i} for the restore drill. Requires ${['Python', 'Go', 'Rust', 'SQL'][i % 4]}.`,
    employmentType: 'INTERNSHIP',
    sourceUrl,
    directApplyUrl: i % 3 === 0 ? `${sourceUrl}/apply` : undefined,
    scrapedAt: new Date(Date.UTC(2026, 7, 1 + (i % 28), i % 24)).toISOString(),
    status: i % 17 === 0 ? 'CLOSED' : 'OPEN',
    raw: { drill: true, index: i },
    canonicalKey: canonicalKey({ sourceName, sourceJobId, canonicalUrl, normalizedCompany, normalizedTitle, normalizedLocation, cycle }),
    canonicalUrl, normalizedCompany, normalizedTitle, normalizedLocation,
    category: i % 5 === 0 ? 'QUANT' : 'SWE',
    cycle,
    sponsorshipStatus: SPONSORSHIP[i % 3]!,
    sponsorshipEvidence: `invented evidence ${i}`,
    graduationEligible: true,
    graduationEvidence: 'invented',
    graduationClaim: (['JUNE_2027', 'DECEMBER_2027', 'JUNE_2028'] as const)[i % 3],
    requiredSkills: ['Python', 'Go', 'Rust', 'SQL'].slice(0, 1 + (i % 4)),
    score: 40 + (i % 80),
    summary: `invented summary ${i}`
  } as ClassifiedJob;
}

async function main(): Promise<void> {
  const applied = await migrate();
  console.log(`migrations applied: ${applied.length}`);

  const jobs: DigestJob[] = [];
  for (let i = 0; i < COUNT; i++) {
    const result = await upsertJob(classified(i));
    jobs.push(result.job);
    if (i % 500 === 0) console.log(`  seeded ${i}`);
  }
  console.log(`jobs written: ${jobs.length}`);

  // Enrichment for a slice, recording the failed fetches as well as the good
  // ones, because "checked and got nothing" is a state the schema keeps.
  await saveEnrichment(jobs.filter((_, i) => i % 4 === 0).map((job, n) => ({
    jobId: job.id!, status: SPONSORSHIP[n % 3]!, evidence: `invented enrichment ${n}`,
    sourceUrl: job.sourceUrl, httpOk: n % 7 !== 0,
    skills: ['Python', 'Kubernetes'], summary: `invented enrichment summary ${n}`
  })));

  // Digests. Some confirmed sent, one claimed and never confirmed, one
  // abandoned, which is the state a send that died halfway leaves behind.
  const perBatch = 40;
  for (let b = 0; b * perBatch < Math.min(jobs.length, perBatch * 12); b++) {
    const slice = jobs.slice(b * perBatch, (b + 1) * perBatch);
    if (!slice.length) break;
    const { batchKey } = await prepareEmailBatch(newRunId(), slice, `Invented digest ${b}`);
    if (b < 10) await markBatchSent(batchKey, `invented-message-${b}`);
    if (b === 11) await pool.query("UPDATE email_batches SET status='ABANDONED' WHERE batch_key=$1", [batchKey]);
  }

  await recordSourceRuns(newRunId(), SOURCES.map((sourceName, i) => ({
    sourceName, status: i === 4 ? 'DEGRADED' : 'SUCCESS', jobs: [],
    startedAt: new Date(Date.UTC(2026, 8, 1, 6)).toISOString(),
    finishedAt: new Date(Date.UTC(2026, 8, 1, 6, 1)).toISOString(),
    durationMs: 60_000 + i, fetchedCount: 100 + i, acceptedCount: 90 + i, rejectedCount: 10,
    costUnits: 0, metrics: { invented: true }
  } as never)));

  for (let i = 0; i < 25; i++) {
    await savePageWatch({
      url: `https://careers.example.invalid/program-${i}`, company: COMPANIES[i % COMPANIES.length]!,
      label: `invented watch ${i}`, hash: `hash-${i}`, textLength: 1000 + i, httpOk: i % 6 !== 0,
      error: i % 6 === 0 ? 'invented 403' : undefined
    }, i % 3 === 0);
  }

  // Invented ledger exclusions. Real page ids are not needed to prove a restore
  // brought the table back, and using invented ones keeps a real ledger out of
  // a throwaway database.
  await syncLedgerExclusions(Array.from({ length: 60 }, (_, i) => ({
    notionPageId: `invented-page-${i}`, companyNormalized: normalizeText(COMPANIES[i % COMPANIES.length]!),
    titleNormalized: normalizeText(TITLES[i % TITLES.length]!),
    canonicalUrl: `https://boards.example.invalid/applied/${i}`,
    sourceJobId: `REQ-${200000 + i}`, kind: (['APPLIED', 'INELIGIBLE', 'DUPLICATE'] as const)[i % 3]
  })) as never);

  for (let i = 0; i < COMPANIES.length; i++) {
    await pool.query(
      `INSERT INTO employer_h1b_approvals(company_normalized,approvals,fiscal_years,source)
       VALUES($1,$2,$3,'invented') ON CONFLICT DO NOTHING`,
      [normalizeText(COMPANIES[i]!), 1 + i * 3, [2024, 2025]]);
    await pool.query(
      `INSERT INTO watchlist_states(company,cycle,state,last_checked_at) VALUES($1,$2,$3,now())
       ON CONFLICT DO NOTHING`,
      [COMPANIES[i]!, CYCLES[i % 2]!, (['OPEN', 'ANNOUNCED', 'EXPECTED', 'NO_SIGNAL', 'CLOSED'])[i % 5]]);
    await pool.query(
      `INSERT INTO company_aliases(alias_normalized,canonical_company) VALUES($1,$2) ON CONFLICT DO NOTHING`,
      [`${normalizeText(COMPANIES[i]!)} group`, COMPANIES[i]!]);
    // ON CONFLICT like its three neighbours: the drill seeds three times, into
    // one database, and these twenty reference rows are the same on every
    // pass. Without it the second seed dies on
    // sponsorship_override_source_idx, which is a partial unique index on
    // (company_normalized, source_job_id).
    await pool.query(
      `INSERT INTO sponsorship_overrides(company_normalized,source_job_id,status,evidence)
       VALUES($1,$2,$3,'invented override') ON CONFLICT DO NOTHING`,
      [normalizeText(COMPANIES[i]!), `REQ-${300000 + i}`, SPONSORSHIP[i % 3]!]);
  }

  const counts = await pool.query<{ table_name: string; n: string }>(`
    SELECT 'jobs' AS table_name, count(*)::text AS n FROM jobs
    UNION ALL SELECT 'job_sources', count(*)::text FROM job_sources
    UNION ALL SELECT 'job_enrichment', count(*)::text FROM job_enrichment
    UNION ALL SELECT 'email_batches', count(*)::text FROM email_batches
    UNION ALL SELECT 'source_runs', count(*)::text FROM source_runs
    UNION ALL SELECT 'page_watches', count(*)::text FROM page_watches
    UNION ALL SELECT 'applied_exclusions', count(*)::text FROM applied_exclusions
    UNION ALL SELECT 'employer_h1b_approvals', count(*)::text FROM employer_h1b_approvals
    UNION ALL SELECT 'watchlist_states', count(*)::text FROM watchlist_states
    UNION ALL SELECT 'company_aliases', count(*)::text FROM company_aliases
    UNION ALL SELECT 'sponsorship_overrides', count(*)::text FROM sponsorship_overrides
    ORDER BY 1`);
  for (const row of counts.rows) console.log(`  ${row.table_name.padEnd(24)} ${row.n}`);
  await pool.end();
}

main().catch(error => { console.error(error); process.exit(1); });
