import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { config, loadCompanyAliases, loadSponsorshipPatterns, projectRoot, watchlistPath } from './config.js';
import { buildAliasMap, canonicalizeUrl, canonicalKey, extractSourceJobId, normalizeCompany, normalizeText } from './normalization.js';
import { classifyCategory, classifyCycle, classifyGraduation, classifyLocation, classifySponsorship, extractSkills, scoreJob } from './classification.js';
import { parseWatchlist, rotateWatchlist, type WatchlistCompany } from './watchlist.js';
import type { ClassifiedJob, DigestJob, PipelineReport, RawJob, SourceAdapter, SourceResult } from './types.js';
import { enrichSponsorship } from './enrichment.js';
import { loadCommunitySources } from './sources/community.js';
import { ApifySource } from './sources/apify.js';
import { loadAtsSources } from './sources/ats.js';
import { loadLinkedInSources } from './sources/linkedin.js';
import { checkWatchedPages, loadWatchPages, type PageChange } from './sources/pagewatch.js';
import { skippedSource } from './sources/base.js';
import { readAppliedExclusions, isApplied, type AppliedExclusion } from './notion.js';
import { buildDigest, type ProgramChange } from './digest.js';
import { getPageWatchState, savePageWatch, closeStaleJobs, getEnrichment, getUnsentJobIds, isSourceDue, saveEnrichment, loadCachedAppliedExclusions, loadCompanyAliasRows, loadSponsorshipOverrides, prepareEmailBatch, recordSourceRuns, syncAppliedExclusions, upsertJob, withPipelineLock, type SponsorshipOverrideRow } from './db.js';
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
  const [community, ats, linkedin] = await Promise.all([loadCommunitySources(), loadAtsSources(), loadLinkedInSources()]);
  const sources: SourceAdapter[] = [...community, ...ats];
  const deferred: SourceResult[] = [];
  // Twice a day, gated on the same watermark the Apify actors use. A dry run is
  // always allowed through so the source can be exercised without waiting.
  for (const source of linkedin) {
    const due = !options.persistent || await isSourceDue(source.name, config.LINKEDIN_MIN_INTERVAL_HOURS);
    if (due) sources.push(source);
    else {
      // SKIPPED, not SUCCESS: a source that did not run must never look like a
      // source that ran and found nothing. That is the distinction whose absence
      // let three community feeds report healthy while parsing zero rows.
      deferred.push({ ...skippedSource(source.name, `not due: runs every ${config.LINKEDIN_MIN_INTERVAL_HOURS}h`), metrics: { skippedDueToCadence: true, minimumIntervalHours: config.LINKEDIN_MIN_INTERVAL_HOURS } });
    }
  }
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
        deferred.push({ ...skippedSource(source.name, `not due: runs every ${config.APIFY_MIN_INTERVAL_HOURS}h`), metrics: { skippedDueToCadence: true, minimumIntervalHours: config.APIFY_MIN_INTERVAL_HOURS } });
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
  const place = classifyLocation(location);
  const cycle = classifyCycle(title, description, raw.cycleHint ?? '');
  const graduation = classifyGraduation(title, description);
  let sponsorship = classifySponsorship(`${title}\n${description}`, context.patterns);
  const canonicalUrl = canonicalizeUrl(raw.directApplyUrl ?? raw.sourceUrl);
  const skills = extractSkills(`${title}\n${description}`);
  const normalizedTitle = normalizeText(title);
  const normalizedLocation = normalizeText(location);
  let rejectionReason: string | undefined;
  if (raw.status === 'CLOSED') rejectionReason = 'closed_or_expired';
  // Plurals: "Internships" ends the match on a word character, so \b fails and
  // "Quant Analyst Internships 2027" read as not a student role at all. The
  // same held for "Interns" and "Students". "Internal" and "International"
  // still do not match, because \b fails on the letter after "intern".
  else if (!/\b(interns?(?:hips?)?|co-?ops?|students?|early career|new grad(?:uate)?s?)\b/i.test(`${title} ${description}`)) rejectionReason = 'not_student_role';
  else if (!place.eligible) rejectionReason = 'outside_us';
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
// list, "6 locations Atlanta, GA …", "Atlanta, GA +5", "New York, NY
// (multiple)", so those must share a bucket. Two postings each naming a single
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

// One requisition posted to six cities is six postings, and the database is
// right to keep them apart: each has its own apply link and its own city. The
// digest is a different question. IBM's ServiceNow internship filled six of
// thirteen rows in one email, so a row is now a requisition and the cities are
// listed on it. titleSignature already sorts its tokens, which is what makes
// "2027-ServiceNow" and "ServiceNow 2027" the same requisition and keeps the
// AWS posting separate.
export interface RequisitionGroup { display: DigestJob; members: DigestJob[] }

function mergedLocation(members: DigestJob[]): string {
  const places = [...new Set(members.map(job => job.location ?? 'Unspecified'))];
  if (places.length === 1) return places[0]!;
  // Three, then a count. The whole list of a dozen cities buries the role.
  return places.length <= 3 ? places.join(' · ') : `${places.slice(0, 3).join(' · ')} +${places.length - 3} more`;
}

export function collapseByRequisition(jobs: DigestJob[]): RequisitionGroup[] {
  const groups = new Map<string, DigestJob[]>();
  jobs.forEach((job, index) => {
    const signature = titleSignature(job.normalizedTitle);
    // No signature means nothing to group on, so it stands alone.
    const key = signature ? `${job.normalizedCompany}|${job.cycle}|${signature}` : `alone:${index}`;
    const members = groups.get(key);
    if (members) members.push(job); else groups.set(key, [job]);
  });
  return [...groups.values()].map(members => {
    const ranked = [...members].sort((a, b) => b.score - a.score);
    const best = ranked[0]!;
    const location = mergedLocation(ranked);
    return { display: location === best.location ? best : { ...best, location }, members: ranked };
  });
}

/**
 * Folds what reading a posting's page taught us back into the role.
 *
 * Separate from the pipeline that calls it because the rescore is the half that
 * is easy to lose: the score is fixed at classification, before any page has
 * been fetched, so skills recovered here and a sponsorship promoted here were
 * both invisible to it. The same LPL requisition scored 116 arriving from a
 * source that carried a description and 91 from one that did not, and that gap
 * decided the order of the digest and which roles the cap reached at all.
 */
export function applyEnrichment(
  job: DigestJob,
  verdict: { status?: string; evidence?: string; skills?: string[]; summary?: string } | undefined,
  priorities: Map<string, number>
): DigestJob {
  // Promote a confirmed yes so the digest's "Strong matches" section can
  // finally distinguish it from everything merely unstated.
  if (verdict?.status === 'SUPPORTED') {
    job.sponsorshipStatus = 'SUPPORTED';
    job.sponsorshipEvidence = verdict.evidence ?? job.sponsorshipEvidence;
  }
  // Only fill what the source left empty. A list that supplied prose of its own
  // is describing the requisition; the page is the fallback, not an improvement.
  if (verdict?.skills?.length && !job.requiredSkills.length) job.requiredSkills = verdict.skills;
  if (verdict?.summary && job.summary.startsWith('The source did not provide')) job.summary = verdict.summary;
  job.score = scoreJob({
    cycle: job.cycle, category: job.category, sponsorshipStatus: job.sponsorshipStatus,
    skills: job.requiredSkills, postedAt: job.postedAt, location: job.location,
    watchlistPriority: priorities.get(job.normalizedCompany) ?? 0
  });
  return job;
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
      // The requisition id without the source name. canonicalKey prefixes the
      // source, so one Lever posting reached the digest four times: twice from
      // the board and twice from lists that link to that same Lever URL. The id
      // is what makes them the same job; who found it is not. Company-scoped
      // because a Workday R-number is only unique within its tenant.
      job.sourceJobId ? `req:${job.normalizedCompany}|${job.sourceJobId}` : '',
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
    loadCompanyAliases(), loadSponsorshipPatterns(), parseWatchlist(watchlistPath)
  ]);
  const slot = Math.floor(Date.now() / 7_200_000);
  const watchlistCohort = rotateWatchlist(watchlist, slot, config.WATCHLIST_COMPANIES_PER_RUN);
  const sourceRuns = await collectSources(options, watchlistCohort);
  const now = new Date().toISOString();

  // Program pages announce a cycle before any requisition exists, which is the
  // one thing the rest of the pipeline structurally cannot see.
  const programChanges: ProgramChange[] = [];
  const watchPages = await loadWatchPages();
  if (watchPages.length) {
    const due = !options.persistent || await isSourceDue('page-watch', config.PAGEWATCH_MIN_INTERVAL_HOURS);
    if (!due) {
      sourceRuns.push({ ...skippedSource('page-watch', `not due: runs every ${config.PAGEWATCH_MIN_INTERVAL_HOURS}h`), metrics: { skippedDueToCadence: true, minimumIntervalHours: config.PAGEWATCH_MIN_INTERVAL_HOURS } });
    } else {
      const startedAt = new Date().toISOString();
      const results = await checkWatchedPages(watchPages);
      const known = options.persistent ? await getPageWatchState() : new Map();
      const changes: PageChange[] = [];
      for (const result of results) {
        const previous = known.get(result.url);
        // Only a readable page with a previously recorded hash can register a
        // change; a first sighting establishes the baseline instead of firing.
        const changed = Boolean(result.hash && previous?.contentHash && previous.contentHash !== result.hash);
        if (changed) changes.push({ url: result.url, company: result.company, label: result.label, previousLength: previous?.textLength ?? 0, textLength: result.textLength });
        if (options.persistent) await savePageWatch(result, changed);
      }
      for (const change of changes) programChanges.push({ company: change.company, label: change.label, url: change.url });
      if (changes.length) log('warn', 'program_pages_changed', { runId, changed: changes.map(change => change.company) });
      const unreadable = results.filter(result => !result.hash);
      sourceRuns.push({
        sourceName: 'page-watch', status: unreadable.length === results.length && results.length > 0 ? 'FAILED' : 'SUCCESS',
        jobs: [], startedAt, finishedAt: new Date().toISOString(), durationMs: 0, costUnits: 0,
        error: unreadable.length ? `${unreadable.length} of ${results.length} pages unreadable` : undefined,
        metrics: { watched: results.length, readable: results.length - unreadable.length, changed: changes.length }
      });
    }
  }
  // Coverage is reported every run because its absence is what hid the gap:
  // 288 of 338 target companies produced nothing for weeks and no number said so.
  const watchlistNames = new Set(watchlist.map(company => normalizeText(company.parent)));
  const companiesWithRoles = new Set<string>();
  for (const run of sourceRuns) for (const job of run.jobs) {
    const normalized = normalizeText(job.company);
    if (watchlistNames.has(normalized)) companiesWithRoles.add(normalized);
  }
  sourceRuns.push({ sourceName: 'watchlist-rotation', status: 'SUCCESS', jobs: [], startedAt: now, finishedAt: now, durationMs: 0, costUnits: 0, metrics: { slot, scheduledCompanies: watchlistCohort.map(company => company.parent), linkedInScanEnabled: !options.liveFree && (config.APIFY_ENABLED || config.PAID_SOURCES_ENABLED), totalCompanies: watchlist.length, watchlistCompaniesWithRoles: companiesWithRoles.size, watchlistCoveragePercent: watchlist.length ? Math.round((100 * companiesWithRoles.size) / watchlist.length) : 0 } });
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
  let enrichmentDropped = 0;
  if (options.persistent && config.ENRICHMENT_ENABLED && digestJobs.length) {
    // Oversample: some candidates will be dropped once their page is read, and
    // the digest should still fill. Enrich only what has never been resolved,
    // so a drained backlog costs a handful of requests per run rather than 90.
    const shortlist = diversifiedTop(digestJobs, Math.min(config.ENRICHMENT_MAX_JOBS, digestJobs.length));
    const known = await getEnrichment(shortlist.map(job => job.id).filter((id): id is string => Boolean(id)));
    const pending = shortlist.filter(job => job.id && !known.has(job.id));
    if (pending.length) {
      const verdicts = await enrichSponsorship(pending, patterns);
      await saveEnrichment(verdicts);
      for (const verdict of verdicts) known.set(verdict.jobId, { status: verdict.status, evidence: verdict.evidence, httpOk: verdict.httpOk, skills: verdict.skills, summary: verdict.summary });
    }
    digestJobs = digestJobs.filter(job => {
      const verdict = job.id ? known.get(job.id) : undefined;
      if (verdict?.status === 'UNSUPPORTED') { enrichmentDropped += 1; return false; }
      applyEnrichment(job, verdict, priorities);
      return true;
    });
    if (enrichmentDropped) log('warn', 'enrichment_dropped_roles', { runId, dropped: enrichmentDropped });
  }
  // Group first, then cap, so the cap counts requisitions rather than spending
  // itself on one employer's six cities.
  let groups = collapseByRequisition(digestJobs);
  if (groups.length > config.DIGEST_MAX_ROLES) {
    const keep = new Set(diversifiedTop(groups.map(group => group.display), config.DIGEST_MAX_ROLES).map(job => job.canonicalKey));
    groups = groups.filter(group => keep.has(group.display.canonicalKey));
  }
  // Every member goes into the batch even though one row represents them, so
  // each city still gets sent_at stamped. Dropping them here would leave them
  // unsent and mail the whole family again on the next tick.
  digestJobs = groups.flatMap(group => group.members);
  if (digestCandidates > digestJobs.length) {
    log('info', 'digest_capped', { runId, sending: digestJobs.length, rows: groups.length, deferred: digestCandidates - digestJobs.length - enrichmentDropped, droppedUnsupported: enrichmentDropped });
  }
  const digest = buildDigest(groups.map(group => group.display), sourceRuns, new Date(), programChanges);
  if ((digestJobs.length > 0 || programChanges.length > 0) && options.persistent && config.SEND_EMAIL_ENABLED) {
    // Program-change URLs join the batch key so a change is emailed once, the
    // same way a role is, instead of re-sending every run while the page stays
    // changed or being swallowed when there are no new roles to key on.
    const batch = await prepareEmailBatch(runId, digestJobs, digest.subject, programChanges.map(change => `page:${change.url}`));
    batchKey = batch.batchKey;
    shouldSend = batch.claimed;
    // A recovered batch means a previous send never confirmed. Say so loudly:
    // the silent version of this failure is what blocks a digest indefinitely.
    if (batch.reclaimed) log('warn', 'email_batch_reclaimed', { runId, batchKey, staleMinutes: config.EMAIL_BATCH_STALE_MINUTES });
    if (!shouldSend) log('warn', 'email_batch_not_claimed', { runId, batchKey, digest: digestJobs.length });
  } else if ((digestJobs.length > 0 || programChanges.length > 0) && options.persistent && !config.SEND_EMAIL_ENABLED) {
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
