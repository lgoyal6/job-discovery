import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { config, loadCompanyAliases, loadSponsorshipPatterns, projectRoot } from './config.js';
import { buildAliasMap, canonicalizeUrl, canonicalKey, extractSourceJobId, normalizeCompany, normalizeText } from './normalization.js';
import { classifyCategory, classifyCycle, classifyGraduation, classifySponsorship, extractSkills, scoreJob } from './classification.js';
import { parseWatchlist, rotateWatchlist, type WatchlistCompany } from './watchlist.js';
import type { ClassifiedJob, DigestJob, PipelineReport, RawJob, SourceAdapter, SourceResult } from './types.js';
import { loadCommunitySources } from './sources/community.js';
import { ApifySource } from './sources/apify.js';
import { loadAtsSources } from './sources/ats.js';
import { skippedSource } from './sources/base.js';
import { readAppliedExclusions, isApplied, type AppliedExclusion } from './notion.js';
import { buildDigest } from './digest.js';
import { closeStaleJobs, getUnsentJobIds, isSourceDue, loadCachedAppliedExclusions, loadCompanyAliasRows, loadSponsorshipOverrides, prepareEmailBatch, recordSourceRuns, syncAppliedExclusions, upsertJob, withPipelineLock, type SponsorshipOverrideRow } from './db.js';
import { log } from './logger.js';

interface RunOptions { fixtures?: boolean; liveFree?: boolean; persistent?: boolean }

const rawJobSchema = z.object({
  sourceName: z.string(), sourceJobId: z.string().optional(), title: z.string(), company: z.string(), location: z.string().optional(),
  postedAt: z.string().optional(), description: z.string().optional(), employmentType: z.string().optional(), sourceUrl: z.string(),
  directApplyUrl: z.string().optional(), scrapedAt: z.string(), cycleHint: z.string().optional(), status: z.enum(['OPEN', 'CLOSED']).optional(), raw: z.unknown().optional()
});

async function fixtureRuns(): Promise<SourceResult[]> {
  const payload = z.array(rawJobSchema).parse(JSON.parse(await readFile(resolve(projectRoot, 'fixtures/jobs.json'), 'utf8')));
  const now = new Date().toISOString();
  return [{ sourceName: 'fixtures', status: 'SUCCESS', jobs: payload, startedAt: now, finishedAt: now, durationMs: 0, costUnits: 0 }, skippedSource('notion-applied', 'fixture mode: no network or credentials used'), skippedSource('apify:linkedin', 'fixture mode: credentialed actor calls disabled'), skippedSource('apify:indeed', 'fixture mode: credentialed actor calls disabled'), skippedSource('apify:monster', 'fixture mode: credentialed actor calls disabled')];
}

async function collectSources(options: RunOptions, watchlistCohort: WatchlistCompany[]): Promise<SourceResult[]> {
  if (options.fixtures) return fixtureRuns();
  const [community, ats] = await Promise.all([loadCommunitySources(), loadAtsSources()]);
  const sources: SourceAdapter[] = [...community, ...ats];
  const deferred: SourceResult[] = [];
  if (!options.liveFree) {
    const apify = [
      new ApifySource('linkedin', config.APIFY_LINKEDIN_ACTOR, config.APIFY_LINKEDIN_MAX_RESULTS, watchlistCohort.map(company => company.parent)),
      new ApifySource('indeed', config.APIFY_INDEED_ACTOR, config.APIFY_INDEED_MAX_RESULTS),
      new ApifySource('monster', config.APIFY_MONSTER_ACTOR, config.APIFY_MONSTER_MAX_RESULTS)
    ];
    for (const source of apify.slice(0, config.APIFY_MAX_ACTOR_RUNS_PER_PIPELINE)) {
      const due = !options.persistent || await isSourceDue(source.name, config.APIFY_MIN_INTERVAL_HOURS);
      if (due) sources.push(source);
      else {
        const now = new Date().toISOString();
        deferred.push({ sourceName: source.name, status: 'SUCCESS', jobs: [], startedAt: now, finishedAt: now, durationMs: 0, costUnits: 0, metrics: { skippedDueToCadence: true, minimumIntervalHours: config.APIFY_MIN_INTERVAL_HOURS } });
      }
    }
  }
  const results = await Promise.all(sources.map(source => source.fetch()));
  if (options.liveFree) results.push(skippedSource('notion-applied', 'live-free mode: credentials are not used'), skippedSource('apify:linkedin', 'live-free mode: credentialed actors disabled'), skippedSource('apify:indeed', 'live-free mode: credentialed actors disabled'), skippedSource('apify:monster', 'live-free mode: credentialed actors disabled'));
  return [...results, ...deferred];
}

function shortSummary(description = ''): string {
  const text = description.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, 280) : 'The source did not provide a verifiable description summary.';
}

export async function classifyRawJob(raw: RawJob, context: { aliases: Map<string, string>; patterns: Awaited<ReturnType<typeof loadSponsorshipPatterns>>; priorities: Map<string, number>; sponsorshipOverrides?: SponsorshipOverrideRow[] }): Promise<ClassifiedJob> {
  const title = raw.title.trim();
  const company = normalizeCompany(raw.company, context.aliases);
  const location = raw.location?.trim() || 'Unspecified';
  const description = raw.description ?? '';
  const role = classifyCategory(title, description);
  const cycle = classifyCycle(title, description, raw.cycleHint ?? '');
  const graduation = classifyGraduation(title, description);
  let sponsorship = classifySponsorship(`${title}\n${description}`, context.patterns);
  const canonicalUrl = canonicalizeUrl(raw.directApplyUrl ?? raw.sourceUrl);
  const skills = extractSkills(`${title}\n${description}`);
  const normalizedTitle = normalizeText(title);
  const normalizedLocation = normalizeText(location);
  let rejectionReason: string | undefined;
  if (raw.status === 'CLOSED') rejectionReason = 'closed_or_expired';
  else if (!/\b(intern(?:ship)?|co-?op|student|early career|new grad(?:uate)?)\b/i.test(`${title} ${description}`)) rejectionReason = 'not_student_role';
  else if (!cycle) rejectionReason = 'outside_target_cycles';
  else if (!role.eligible) rejectionReason = role.reason ?? 'not_technical';
  else if (!graduation.eligible) rejectionReason = 'graduation_incompatible';
  else if (sponsorship.status === 'UNSUPPORTED') rejectionReason = 'sponsorship_unsupported';
  const resolvedCycle = cycle ?? 'Later compatible';
  const sourceJobId = raw.sourceJobId || extractSourceJobId(canonicalUrl);
  const sponsorshipOverride = context.sponsorshipOverrides?.find(override => override.companyNormalized === company.normalized && ((override.sourceJobId && override.sourceJobId === sourceJobId) || (override.canonicalUrl && canonicalizeUrl(override.canonicalUrl) === canonicalUrl)));
  if (sponsorshipOverride) {
    sponsorship = { status: sponsorshipOverride.status, evidence: sponsorshipOverride.evidence };
    if (rejectionReason === 'sponsorship_unsupported' && sponsorship.status !== 'UNSUPPORTED') rejectionReason = undefined;
  }
  if (sponsorship.status === 'UNSUPPORTED') rejectionReason = 'sponsorship_unsupported';
  return {
    ...raw, sourceJobId, company: company.display, location, canonicalUrl, normalizedCompany: company.normalized, normalizedTitle, normalizedLocation,
    canonicalKey: canonicalKey({ sourceName: raw.sourceName, sourceJobId, canonicalUrl, normalizedCompany: company.normalized, normalizedTitle, normalizedLocation, cycle: resolvedCycle }),
    category: role.category, cycle: resolvedCycle, sponsorshipStatus: sponsorship.status, sponsorshipEvidence: sponsorship.evidence,
    graduationEligible: graduation.eligible, graduationEvidence: graduation.evidence, requiredSkills: skills,
    score: scoreJob({ cycle: resolvedCycle, category: role.category, sponsorshipStatus: sponsorship.status, skills, postedAt: raw.postedAt, location, watchlistPriority: context.priorities.get(company.normalized) ?? 0 }),
    rejectionReason, summary: shortSummary(description)
  };
}

// Words that vary between lists describing the same requisition. Dropping them
// lets "SWE Intern - C++ or Python", "Software Engineering Internship - C++ or
// Python - Summer 2027" and "Software Engineering Intern (Summer 2027, C++ /
// Python)" collapse to one row instead of three.
const TITLE_NOISE = /^(intern|interns|internship|internships|co|op|coop|summer|fall|winter|spring|20\d\d|the|and|or|a|an|of|for|at|in|to|program|programme)$/;

// Truncation is what makes engineer/engineering agree. Five characters is short
// enough to stem those pairs and long enough that backend/frontend, undergrad/
// masters, and distinct team suffixes stay separate.
// One requisition open in several cities gets rendered differently by every
// list — "6 locations Atlanta, GA …", "Atlanta, GA +5", "New York, NY
// (multiple)" — so those must share a bucket. Two postings each naming a single
// distinct city are genuinely separate roles and must not.
const MULTI_LOCATION = /\+\s*\d|\b\d+\s+locations?\b|\bmultiple\b|\bvarious\b/i;
function locationBucket(location: string, normalizedLocation: string): string {
  if (MULTI_LOCATION.test(location) || location.split(',').length >= 3) return '*';
  return normalizedLocation;
}

function titleSignature(normalizedTitle: string): string {
  const tokens = normalizedTitle.split(/[^a-z0-9+#]+/)
    .filter(token => token && !TITLE_NOISE.test(token))
    .map(token => token.slice(0, 5));
  return [...new Set(tokens)].sort().join('.');
}

// A flat score sort hands the whole cap to whoever posts the most: dozens of
// roles tie on score, the tiebreak is alphabetical, and one high-volume employer
// takes 40% of the digest. Deal one role per company per pass instead, companies
// ordered by their best role, so breadth wins before any employer gets seconds.
export function diversifiedTop(jobs: DigestJob[], limit: number): DigestJob[] {
  const ranked = [...jobs].sort((a, b) => b.score - a.score || a.company.localeCompare(b.company));
  const queues = new Map<string, DigestJob[]>();
  for (const job of ranked) {
    const key = job.normalizedCompany || job.company;
    const queue = queues.get(key);
    if (queue) queue.push(job); else queues.set(key, [job]);
  }
  const picked: DigestJob[] = [];
  const rotation = [...queues.values()];
  let dealt = true;
  while (picked.length < limit && dealt) {
    dealt = false;
    for (const queue of rotation) {
      if (picked.length >= limit) break;
      const next = queue.shift();
      if (next) { picked.push(next); dealt = true; }
    }
  }
  return picked;
}

export function localDedupe(jobs: ClassifiedJob[]): { unique: ClassifiedJob[]; count: number } {
  const seen = new Set<string>();
  const unique: ClassifiedJob[] = [];
  let count = 0;
  for (const job of jobs.sort((a, b) => b.score - a.score)) {
    const signature = titleSignature(job.normalizedTitle);
    const keys = [
      `key:${job.canonicalKey}`,
      job.canonicalUrl.startsWith('http') ? `url:${job.canonicalUrl}` : '',
      `tuple:${job.normalizedCompany}|${job.normalizedTitle}|${job.normalizedLocation}|${job.cycle}`,
      // Same company, same cycle, same role in different words.
      signature ? `sig:${job.normalizedCompany}|${job.cycle}|${locationBucket(job.location ?? '', job.normalizedLocation)}|${signature}` : ''
    ].filter(Boolean);
    if (keys.some(key => seen.has(key))) { count += 1; continue; }
    keys.forEach(key => seen.add(key)); unique.push(job);
  }
  return { unique, count };
}

async function execute(options: RunOptions): Promise<PipelineReport> {
  const runId = randomUUID();
  const [aliasesConfig, patterns, watchlist] = await Promise.all([
    loadCompanyAliases(), loadSponsorshipPatterns(), parseWatchlist(resolve(projectRoot, '../automation/job-company-watchlist.md'))
  ]);
  const slot = Math.floor(Date.now() / 7_200_000);
  const watchlistCohort = rotateWatchlist(watchlist, slot, config.WATCHLIST_COMPANIES_PER_RUN);
  const sourceRuns = await collectSources(options, watchlistCohort);
  const now = new Date().toISOString();
  sourceRuns.push({ sourceName: 'watchlist-rotation', status: 'SUCCESS', jobs: [], startedAt: now, finishedAt: now, durationMs: 0, costUnits: 0, metrics: { slot, scheduledCompanies: watchlistCohort.map(company => company.parent), linkedInScanEnabled: !options.liveFree && (config.APIFY_ENABLED || config.PAID_SOURCES_ENABLED), totalCompanies: watchlist.length } });
  const aliases = buildAliasMap(aliasesConfig);
  let sponsorshipOverrides: SponsorshipOverrideRow[] = [];
  if (options.persistent) {
    const [aliasRows, overrides] = await Promise.all([loadCompanyAliasRows(), loadSponsorshipOverrides()]);
    for (const row of aliasRows) aliases.set(row.aliasNormalized, row.canonicalCompany);
    sponsorshipOverrides = overrides;
  }
  for (const company of watchlist) for (const alias of company.aliases) aliases.set(normalizeText(alias), company.parent);
  const priorities = new Map(watchlist.flatMap(company => company.aliases.map(alias => [normalizeText(company.parent === alias ? company.parent : aliases.get(normalizeText(alias)) ?? alias), company.priority] as const)));
  let applied: AppliedExclusion[] = [];
  let notionReadSucceeded = false;
  if (!options.fixtures && !options.liveFree) {
    if (!config.NOTION_TOKEN) {
      if (options.persistent) applied = await loadCachedAppliedExclusions();
      sourceRuns.push(skippedSource('notion-applied', `NOTION_TOKEN is not configured; using ${applied.length} cached exclusions`));
    } else {
      try { applied = await readAppliedExclusions(); notionReadSucceeded = true; sourceRuns.push({ ...skippedSource('notion-applied', `read ${applied.length} applied rows`), status: 'SUCCESS' }); }
      catch (error) {
        if (options.persistent) applied = await loadCachedAppliedExclusions();
        sourceRuns.push({ ...skippedSource('notion-applied', `${error instanceof Error ? error.message : String(error)}; using ${applied.length} cached exclusions`), status: 'FAILED' });
      }
    }
  }
  applied = applied.map(exclusion => ({ ...exclusion, companyNormalized: normalizeCompany(exclusion.companyNormalized, aliases).normalized }));
  const raw = sourceRuns.flatMap(run => run.jobs);
  const classified = await Promise.all(raw.map(job => classifyRawJob(job, { aliases, patterns, priorities, sponsorshipOverrides })));
  for (const run of sourceRuns) {
    const fromSource = classified.filter(job => job.sourceName === run.sourceName);
    run.metrics = { ...(run.metrics ?? {}), acceptedCount: fromSource.filter(job => !job.rejectionReason).length, rejectedCount: fromSource.filter(job => Boolean(job.rejectionReason)).length };
  }
  const rejectionReasons: Record<string, number> = {};
  let appliedExcluded = 0;
  const eligible = classified.filter(job => {
    if (job.rejectionReason) { rejectionReasons[job.rejectionReason] = (rejectionReasons[job.rejectionReason] ?? 0) + 1; return false; }
    if (isApplied(job, applied)) { appliedExcluded += 1; rejectionReasons.already_applied = (rejectionReasons.already_applied ?? 0) + 1; return false; }
    return true;
  });
  const deduped = localDedupe(eligible);
  let digestJobs: DigestJob[] = deduped.unique;
  let batchKey: string | null = null;
  let shouldSend = false;
  if (options.persistent) {
    if (notionReadSucceeded) await syncAppliedExclusions(applied);
    await recordSourceRuns(runId, sourceRuns);
    const stored = await Promise.all(deduped.unique.map(upsertJob));
    await closeStaleJobs();
    const unsentIds = await getUnsentJobIds(stored.map(item => item.job.id).filter((id): id is string => Boolean(id)));
    digestJobs = stored.map(item => item.job).filter(job => job.id && unsentIds.has(job.id));
  }
  // Highest score first, then cap. Whatever is left keeps sent_at NULL and is
  // picked up by the next tick, so a backlog drains over several readable
  // emails instead of one Gmail truncates while marking every role sent.
  const digestCandidates = digestJobs.length;
  if (digestJobs.length > config.DIGEST_MAX_ROLES) {
    digestJobs = diversifiedTop(digestJobs, config.DIGEST_MAX_ROLES);
    log('info', 'digest_capped', { runId, sending: digestJobs.length, deferred: digestCandidates - digestJobs.length });
  }
  const digest = buildDigest(digestJobs, sourceRuns);
  if (digestJobs.length > 0 && options.persistent && config.SEND_EMAIL_ENABLED) {
    const batch = await prepareEmailBatch(runId, digestJobs, digest.subject);
    batchKey = batch.batchKey;
    shouldSend = batch.claimed;
    // A recovered batch means a previous send never confirmed. Say so loudly:
    // the silent version of this failure is what blocks a digest indefinitely.
    if (batch.reclaimed) log('warn', 'email_batch_reclaimed', { runId, batchKey, staleMinutes: config.EMAIL_BATCH_STALE_MINUTES });
    if (!shouldSend) log('warn', 'email_batch_not_claimed', { runId, batchKey, digest: digestJobs.length });
  } else if (digestJobs.length > 0 && options.persistent && !config.SEND_EMAIL_ENABLED) {
    // Suppressing a real digest is indistinguishable from having nothing to send
    // unless it is recorded; an unset flag defaults to off and reads as healthy.
    log('warn', 'email_send_disabled', { runId, digest: digestJobs.length });
  }
  log('info', 'pipeline_complete', { runId, raw: raw.length, eligible: eligible.length, digest: digestJobs.length, shouldSend, dryRun: !options.persistent });
  return {
    runId, dryRun: !options.persistent, batchKey, shouldSend, emailTo: config.EMAIL_TO,
    subject: digestJobs.length ? digest.subject : null, html: digestJobs.length ? digest.html : null, text: digestJobs.length ? digest.text : null,
    jobs: digestJobs, sourceRuns: sourceRuns.map(run => ({ ...run, jobs: [], metrics: { ...(run.metrics ?? {}), fetchedCount: run.jobs.length } })),
    counts: { raw: raw.length, accepted: digestJobs.length, rejected: classified.length - eligible.length, deduplicated: deduped.count, appliedExcluded },
    rejectionReasons, degradedSources: sourceRuns.filter(run => run.status !== 'SUCCESS').map(run => run.sourceName), notionModified: false
  };
}

export async function runPipeline(options: RunOptions): Promise<PipelineReport> {
  return options.persistent ? withPipelineLock(() => execute(options)) : execute(options);
}
