import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { config, loadCompanyAliases, loadVerifiedNonSponsors, loadSponsorshipPatterns, projectRoot, watchlistPath, activeProfile } from './config.js';
import { applyLinkRank, buildAliasMap, canonicalizeUrl, canonicalKey, canonicalLocation, extractSourceJobId, locationBucket, normalizeCompany, normalizeText, requisitionSignature, titleSignature } from './normalization.js';
import { NEW_GRAD_ROLE, classifyCycle, classifyEarlyCareer, classifyGraduation, classifyLocation, classifySponsorship, extractSkills, scoreJob, STUDENT_ROLE, rolePolicies } from './classification.js';
import { parseWatchlist, rotateWatchlist, type WatchlistCompany } from './watchlist.js';
import type { ClassifiedJob, DigestJob, NotionExclusionSample, NotionExclusionSource, PipelineReport, RawJob, SourceAdapter, SourceResult } from './types.js';
import { enrichSponsorship } from './enrichment.js';
import { resolveListingLinks } from './apply-links.js';
import { mirrorNewPostings } from './mirror.js';
import { loadCommunitySources } from './sources/community.js';
import { loadInternListSources } from './sources/intern-list.js';
import { ApifySource } from './sources/apify.js';
import { loadAtsSources } from './sources/ats.js';
import { loadLinkedInSources } from './sources/linkedin.js';
import { checkWatchedPages, loadWatchPages, type PageChange } from './sources/pagewatch.js';
import { skippedSource } from './sources/base.js';
import { findLedgerExclusionMatch, readLedgerExclusions, type LedgerExclusion } from './notion.js';
import { buildDigest, digestOrder, type ProgramChange } from './digest.js';
import { getPageWatchState, savePageWatch, closeStaleJobs, getEnrichment, getSentRequisitions, getUnsentJobIds, isSourceDue, saveEnrichment, loadCachedLedgerExclusions, loadH1bSponsors, loadCompanyAliasRows, loadSponsorshipOverrides, prepareEmailBatch, recordSourceRuns, syncLedgerExclusions, upsertJob, withPipelineLock, type SponsorshipOverrideRow } from './db.js';
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

async function collectSources(options: RunOptions, _watchlistCohort: WatchlistCompany[]): Promise<SourceResult[]> {
  if (options.fixtures) return fixtureRuns();
  const [community, internList, ats, linkedin] = await Promise.all([loadCommunitySources(), loadInternListSources(), loadAtsSources(), loadLinkedInSources()]);
  // Boards and LinkedIn queries now carry the profile they belong to and are
  // filtered as they load, so a finance run fetches the investment managers and
  // the trading firms and none of the 160 technical boards. The Apify actors
  // stay technical-only: they are the paid sources, aimed at technical roles by
  // the actor input itself, and a finance run must not spend that budget.
  const boards = ats;
  const greenhouse = config.GREENHOUSE_CONTENT_ENABLED ? boards.filter(source => source.name.startsWith('greenhouse:')) : [];
  const sources: SourceAdapter[] = [...community, ...boards.filter(source => !greenhouse.includes(source))];
  const deferred: SourceResult[] = [];
  // A Greenhouse board carrying descriptions is the most expensive fetch here,
  // about 300 MB across the 93 of them, so it runs on its own cadence rather
  // than every two hours. Same watermark machinery as LinkedIn and Apify.
  for (const source of greenhouse) {
    const due = !options.persistent || await isSourceDue(source.name, config.GREENHOUSE_MIN_INTERVAL_HOURS);
    if (due) sources.push(source);
    else deferred.push({ ...skippedSource(source.name, `not due: runs every ${config.GREENHOUSE_MIN_INTERVAL_HOURS}h`), metrics: { skippedDueToCadence: true, minimumIntervalHours: config.GREENHOUSE_MIN_INTERVAL_HOURS } });
  }
  // Each qualifying row on intern-list costs a request to its own page for the
  // location and prose the list omits, about 130 a list a pass, so it runs on
  // the boards' cadence. Six hours also keeps every row seen well inside the
  // 72-hour window closeStaleJobs closes an unseen posting against.
  for (const source of internList) {
    const due = !options.persistent || await isSourceDue(source.name, config.INTERN_LIST_MIN_INTERVAL_HOURS);
    if (due) sources.push(source);
    else deferred.push({ ...skippedSource(source.name, `not due: runs every ${config.INTERN_LIST_MIN_INTERVAL_HOURS}h`), metrics: { skippedDueToCadence: true, minimumIntervalHours: config.INTERN_LIST_MIN_INTERVAL_HOURS } });
  }
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
    // Monster only, for the finance digest, and it is the economics that decide
    // that rather than the yield. Every one of these actors is priced per event:
    // Monster charges $0.001 a result, so 120 results once a day is $3.72
    // against a $5 monthly credit, while the Indeed actor charges $0.50 per
    // search plus $0.01 a described job, which is one run of a few hundred rows
    // and the month is gone. The LinkedIn actor would buy a fifth copy of what
    // the free guest endpoint already returns 723 of.
    // Indeed is gone from both. Its actor charges $0.50 for each search entry
    // before a single row is written, plus $0.01 a job with the description
    // this asks for, so the two searches configured here cost $1.15 a run and
    // $34 a month against a $5 plan. It has not completed a run in weeks: every
    // one answers HTTP 402 "not enough usage to run paid actor", which spends no
    // money but reports a failed source to the reader every two hours. LinkedIn
    // and Monster both charge per result and both fit.
    // Monster, on both profiles, and nothing else paid. Measured over the
    // pipeline's own history: a posting published in the last ten days reaches
    // the free LinkedIn guest endpoint in a median of 19 hours and the paid
    // actors in 29, and when several sources carry one role the free endpoint
    // is first 62% of the time against the actors' 13%. The actor duplicates
    // what the guest endpoint already returns, arrives later, and cost about
    // $2.10 a month of a $5 plan to do it. Monster earns its place on different
    // ground: it is the only source that returns the employer's own
    // description, which is what the sponsorship rules read.
    const apify = [new ApifySource('monster', config.APIFY_MONSTER_ACTOR, config.APIFY_MONSTER_MAX_RESULTS)];
    for (const source of apify.slice(0, config.APIFY_MAX_ACTOR_RUNS_PER_PIPELINE)) {
      const due = !options.persistent || await isSourceDue(source.name, config.APIFY_MIN_INTERVAL_HOURS);
      if (due) sources.push(source);
      else {
        deferred.push({ ...skippedSource(source.name, `not due: runs every ${config.APIFY_MIN_INTERVAL_HOURS}h`), metrics: { skippedDueToCadence: true, minimumIntervalHours: config.APIFY_MIN_INTERVAL_HOURS } });
      }
    }
  }
  // Bounded, not Promise.all over every source at once. With descriptions on,
  // an unbounded pool holds all 93 Greenhouse payloads in memory together, and
  // it is also what made a 12 MB board expire against a timeout it met easily
  // on its own.
  const queue = [...sources];
  const results: SourceResult[] = [];
  const worker = async (): Promise<void> => {
    for (let source = queue.shift(); source; source = queue.shift()) results.push(await source.fetch());
  };
  await Promise.all(Array.from({ length: Math.min(config.SOURCE_CONCURRENCY, sources.length) }, worker));
  if (options.liveFree) results.push(skippedSource('notion-applied', 'live-free mode: credentials are not used'), skippedSource('apify:linkedin', 'live-free mode: credentialed actors disabled'), skippedSource('apify:indeed', 'live-free mode: credentialed actors disabled'), skippedSource('apify:monster', 'live-free mode: credentialed actors disabled'));
  return [...results, ...deferred];
}

// Greenhouse answers with its `content` field entity-encoded, so there was no
// literal "<" for the tag stripper to find, and the digest then escaped the
// ampersands on the way into the email. Every board row's summary read
// "&lt;p&gt;&lt;span style=&quot;font-size: 12pt;&quot;&gt;About Us" instead of
// a sentence. Decoded before stripping, and "&amp;" last, so a posting that
// really does write "&lt;" in its prose keeps it rather than having it read as
// the start of a tag.
function decodeEntities(value: string): string {
  return value
    .replace(/&(?:nbsp|#160|#x00a0);/gi, ' ')
    .replace(/&(?:lt|#60|#x3c);/gi, '<')
    .replace(/&(?:gt|#62|#x3e);/gi, '>')
    .replace(/&(?:quot|#34|#x22);/gi, '"')
    .replace(/&(?:apos|#39|#x27);/gi, "'")
    .replace(/&(?:amp|#38|#x26);/gi, '&');
}

export function shortSummary(description = ''): string {
  // Decoded twice, because the employer's own HTML is frequently encoded before
  // the board encodes it again: Greenhouse rows carry "&amp;nbsp;" verbatim, and
  // one pass leaves "&nbsp;" sitting in the middle of the sentence.
  const text = decodeEntities(decodeEntities(description)).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, 280) : 'The source did not provide a verifiable description summary.';
}

export async function classifyRawJob(raw: RawJob, context: { aliases: Map<string, string>; patterns: Awaited<ReturnType<typeof loadSponsorshipPatterns>>; priorities: Map<string, number>; sponsorshipOverrides?: SponsorshipOverrideRow[] ; h1bSponsors?: Map<string, number>; verifiedNonSponsors?: Set<string>}): Promise<ClassifiedJob> {
  const title = raw.title.trim();
  const company = normalizeCompany(raw.company, context.aliases);
  const location = raw.location?.trim() || 'Unspecified';
  const description = raw.description ?? '';
  const policy = rolePolicies[activeProfile];
  const role = policy.classifyRole(title, description);
  // The posting's own URL is the fallback evidence when the location field
  // names no country: it is the employer's path to the job and it spells the
  // city out, which is how Ontario Teachers' Toronto internship and Tikehau's
  // London one both reached a US-only digest reading "Unspecified".
  const place = classifyLocation(location, `${title} ${raw.directApplyUrl ?? raw.sourceUrl ?? ''}`);
  const cycle = classifyCycle(title, description, raw.cycleHint ?? '');
  const graduation = classifyGraduation(title, description);
  const earlyCareer = classifyEarlyCareer(title, description);
  let sponsorship = classifySponsorship(`${title}\n${description}`, context.patterns);
  const canonicalUrl = canonicalizeUrl(raw.directApplyUrl ?? raw.sourceUrl);
  const skills = extractSkills(`${title}\n${description}`);
  const normalizedTitle = normalizeText(title);
  // Canonical, not merely lowercased: "Atlanta, GA" and "Atlanta, Georgia,
  // United States" have to be one place here, or every comparison downstream
  // that keys on location treats one role from two lists as two roles.
  const normalizedLocation = canonicalLocation(location);
  let rejectionReason: string | undefined;
  if (raw.status === 'CLOSED') rejectionReason = 'closed_or_expired';
  else if (policy.requireStudentRole && !STUDENT_ROLE.test(`${title} ${description}`)) rejectionReason = 'not_student_role';
  else if (!place.eligible) rejectionReason = 'outside_us';
  else if (policy.requireCycle && !cycle && !NEW_GRAD_ROLE.test(`${title} ${description}`)) rejectionReason = 'outside_target_cycles';
  else if (!role.eligible) rejectionReason = role.reason ?? 'not_technical';
  else if (policy.requireGraduationFit && !graduation.eligible) rejectionReason = 'graduation_incompatible';
  else if (policy.requireEarlyCareer && !earlyCareer.eligible) rejectionReason = 'not_open_to_a_student_or_new_grad';
  // Sponsorship is deliberately not a rejection. A posting that says it cannot
  // sponsor is carried through and reported in its own digest section, because
  // the sentence is boilerplate an employer sometimes departs from and the call
  // is the reader's to make.
  const resolvedCycle = cycle ?? 'Later compatible';
  const sourceJobId = raw.sourceJobId || extractSourceJobId(canonicalUrl);
  const sponsorshipOverride = context.sponsorshipOverrides?.find(override => override.companyNormalized === company.normalized && ((override.sourceJobId && override.sourceJobId === sourceJobId) || (override.canonicalUrl && canonicalizeUrl(override.canonicalUrl) === canonicalUrl)));
  if (sponsorshipOverride) sponsorship = { status: sponsorshipOverride.status, evidence: sponsorshipOverride.evidence };
  // A silent posting is not evidence either way, so ask whether the employer has
  // ever sponsored anyone. Absence is the signal, not the count: a company with
  // three approvals still sponsors, one with none in two full fiscal years
  // probably does not. Status stays UNKNOWN, only the evidence sharpens, so the
  // call remains the reader's.
  // A posting that says nothing about sponsorship gets a second question: has
  // this employer ever sponsored? Only a HAND-CHECKED absence answers it. 634
  // of 832 employers do not resolve to a USCIS legal entity by name alone, and
  // an unresolved name is a lookup we failed, not an employer that fails to
  // sponsor - shipping that distinction backwards would have said AMD, which
  // files as "advanced micro devices" with 790 approvals, does not sponsor.
  // config/uscis-aliases.json carries the checked ones, and its nulls are the
  // employers genuinely absent from the export: defense and space companies
  // that hire citizens, and anything renamed after the data was cut.
  if (sponsorship.status === 'UNKNOWN' && context.verifiedNonSponsors?.has(company.normalized)) {
    sponsorship = { status: 'UNKNOWN', evidence: `${sponsorship.evidence} This employer has no H-1B approvals in the USCIS export, checked by name, so sponsorship is unlikely.` };
  }

  return {
    ...raw, sourceJobId, company: company.display, location, canonicalUrl, normalizedCompany: company.normalized, normalizedTitle, normalizedLocation,
    canonicalKey: canonicalKey({ sourceName: raw.sourceName, sourceJobId, canonicalUrl, normalizedCompany: company.normalized, normalizedTitle, normalizedLocation, cycle: resolvedCycle }),
    category: role.category, cycle: resolvedCycle, sponsorshipStatus: sponsorship.status, sponsorshipEvidence: sponsorship.evidence,
    graduationEligible: graduation.eligible, graduationEvidence: graduation.evidence, graduationClaim: graduation.claim, requiredSkills: skills,
    score: scoreJob({ cycle: resolvedCycle, category: role.category, sponsorshipStatus: sponsorship.status, skills, postedAt: raw.postedAt, location, watchlistPriority: context.priorities.get(company.normalized) ?? 0 }),
    rejectionReason, summary: shortSummary(description)
  };
}

// One requisition posted to six cities is six postings, and the database is
// right to keep them apart: each has its own apply link and its own city. The
// digest is a different question. IBM's ServiceNow internship filled six of
// thirteen rows in one email, so a row is now a requisition and the cities are
// listed on it. titleSignature already sorts its tokens, which is what makes
// "2027-ServiceNow" and "ServiceNow 2027" the same requisition and keeps the
// AWS posting separate.
export interface RequisitionGroup { display: DigestJob; members: DigestJob[] }

export function excludeLedgerMatches(jobs: ClassifiedJob[], exclusions: LedgerExclusion[]): {
  kept: ClassifiedJob[];
  appliedExcluded: number;
  ineligibleExcluded: number;
  duplicateExcluded: number;
  samples: NotionExclusionSample[];
} {
  const kept: ClassifiedJob[] = [];
  const matchedSamples: NotionExclusionSample[] = [];
  let appliedExcluded = 0;
  let ineligibleExcluded = 0;
  let duplicateExcluded = 0;
  for (const job of jobs) {
    const match = findLedgerExclusionMatch(job, exclusions);
    if (!match) { kept.push(job); continue; }
    if (match.exclusion.kind === 'APPLIED') appliedExcluded += 1;
    else if (match.exclusion.kind === 'INELIGIBLE') ineligibleExcluded += 1;
    else duplicateExcluded += 1;
    matchedSamples.push({ kind: match.exclusion.kind, company: job.company, title: job.title, matchBasis: match.basis });
  }
  const samples: NotionExclusionSample[] = [];
  const selected = new Set<NotionExclusionSample>();
  for (const kind of ['INELIGIBLE', 'APPLIED', 'DUPLICATE'] as const) {
    const sample = matchedSamples.find(item => item.kind === kind);
    if (sample) { samples.push(sample); selected.add(sample); }
  }
  for (const sample of matchedSamples) {
    if (samples.length >= 3) break;
    if (!selected.has(sample)) samples.push(sample);
  }
  return { kept, appliedExcluded, ineligibleExcluded, duplicateExcluded, samples };
}

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
    // Which copy speaks for the group. A role open in nine cities can have one
    // source saying it cannot sponsor and another saying nothing, and the row
    // the reader sees decides which section the whole group lands in. The more
    // permissive verdict wins, because sending a role to the sponsorship
    // section on the strength of one location's evidence buries it.
    const permissiveness = (job: DigestJob): number =>
      job.sponsorshipStatus === 'SUPPORTED' ? 2 : job.sponsorshipStatus === 'UNKNOWN' ? 1 : 0;
    const ranked = [...members].sort((a, b) => permissiveness(b) - permissiveness(a) || b.score - a.score);
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
  // finally distinguish it from everything merely unstated, and record a
  // confirmed no so the sponsorship-unlikely section is built on what the
  // posting actually says rather than on what the listing omitted.
  if (verdict?.status === 'SUPPORTED' || verdict?.status === 'UNSUPPORTED') {
    job.sponsorshipStatus = verdict.status;
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
export function diversifiedTop(jobs: DigestJob[], limit: number, perCompany = Infinity): DigestJob[] {
  // The digest's own order, so the cap keeps the roles the email would have led
  // with rather than a different hundred it then has to re-sort.
  const ranked = [...jobs].sort(digestOrder);
  const queues = new Map<string, DigestJob[]>();
  for (const job of ranked) {
    const key = job.normalizedCompany || job.company;
    const queue = queues.get(key);
    // Round-robin alone orders employers fairly but never limits one. American
    // Express files a separate requisition per degree level, role family and
    // city, so 28 of them were live at once, none of them applied to and none
    // of them suppressible; the deal simply came back round to Amex four times
    // and the digest read as the same row over and over.
    if (queue) { if (queue.length < perCompany) queue.push(job); } else queues.set(key, [job]);
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

/**
 * Drops the roles whose requisition has already been emailed under some other
 * database row.
 *
 * The upsert merges what it can prove is the same posting: a shared canonical
 * key, apply URL, requisition id, or an identical company/title/location/cycle.
 * Two lists that word one requisition differently and link to it differently
 * share none of those, so both rows are real and only one of them is news. The
 * key is the one the digest already groups rows by, so a role suppressed here
 * is one that would have been folded into an existing row anyway.
 */
export function dropAlreadySentRequisitions(
  jobs: DigestJob[],
  sent: Array<{ normalizedCompany: string; normalizedTitle: string; cycle: string }>
): { kept: DigestJob[]; suppressed: number } {
  const sentKeys = new Set(sent.map(requisitionSignature).filter((key): key is string => Boolean(key)));
  if (!sentKeys.size) return { kept: jobs, suppressed: 0 };
  const kept = jobs.filter(job => {
    const key = requisitionSignature(job);
    return !key || !sentKeys.has(key);
  });
  return { kept, suppressed: jobs.length - kept.length };
}

export function localDedupe(jobs: ClassifiedJob[]): { unique: ClassifiedJob[]; count: number } {
  const seen = new Set<string>();
  const unique: ClassifiedJob[] = [];
  let count = 0;
  // Link quality first, then score. Both rows describe the same requisition, so
  // the one that can be applied through is the one to keep; score is about the
  // role and cannot tell a form from a write-up.
  const ranked = [...jobs].sort((a, b) =>
    applyLinkRank(b.directApplyUrl ?? b.canonicalUrl) - applyLinkRank(a.directApplyUrl ?? a.canonicalUrl)
    || b.score - a.score);
  for (const job of ranked) {
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
  const watchPages = activeProfile === 'technical' ? await loadWatchPages() : [];
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
  let h1bSponsors = new Map<string, number>();
  const verifiedNonSponsors = await loadVerifiedNonSponsors();
  if (options.persistent) {
    const [aliasRows, overrides, sponsors] = await Promise.all([loadCompanyAliasRows(), loadSponsorshipOverrides(), loadH1bSponsors()]);
    for (const row of aliasRows) aliases.set(row.aliasNormalized, row.canonicalCompany);
    sponsorshipOverrides = overrides;
    h1bSponsors = sponsors;
  }
  for (const company of watchlist) for (const alias of company.aliases) aliases.set(normalizeText(alias), company.parent);
  const priorities = new Map(watchlist.flatMap(company => company.aliases.map(alias => [normalizeText(company.parent === alias ? company.parent : aliases.get(normalizeText(alias)) ?? alias), company.priority] as const)));
  let exclusions: LedgerExclusion[] = [];
  let notionReadSucceeded = false;
  let notionExclusionSource: NotionExclusionSource = 'NONE';
  if (!options.fixtures && !options.liveFree) {
    // The Notion ledger is one person's applied history. Excluding their
    // applications from somebody else's digest is wrong, not conservative.
    if (activeProfile !== 'technical') {
      sourceRuns.push(skippedSource('notion-applied', `${activeProfile} profile: the applied ledger belongs to the technical digest`));
    } else if (!config.NOTION_TOKEN) {
      if (options.persistent) { exclusions = await loadCachedLedgerExclusions(); notionExclusionSource = 'CACHE'; }
      sourceRuns.push(skippedSource('notion-applied', `NOTION_TOKEN is not configured; using ${exclusions.length} cached exclusions`));
    } else {
      try { exclusions = await readLedgerExclusions(); notionReadSucceeded = true; notionExclusionSource = 'LIVE_NOTION'; sourceRuns.push({ ...skippedSource('notion-applied', `read ${exclusions.length} applied, ineligible, or duplicate rows`), status: 'SUCCESS' }); }
      catch (error) {
        if (options.persistent) { exclusions = await loadCachedLedgerExclusions(); notionExclusionSource = 'CACHE'; }
        sourceRuns.push({ ...skippedSource('notion-applied', `${error instanceof Error ? error.message : String(error)}; using ${exclusions.length} cached exclusions`), status: 'FAILED' });
      }
    }
  }
  exclusions = exclusions.map(exclusion => ({ ...exclusion, companyNormalized: normalizeCompany(exclusion.companyNormalized, aliases).normalized }));
  const raw = sourceRuns.flatMap(run => run.jobs);
  const classified = await Promise.all(raw.map(job => classifyRawJob(job, { aliases, patterns, priorities, sponsorshipOverrides, h1bSponsors, verifiedNonSponsors })));
  for (const run of sourceRuns) {
    const fromSource = classified.filter(job => job.sourceName === run.sourceName);
    run.metrics = { ...(run.metrics ?? {}), acceptedCount: fromSource.filter(job => !job.rejectionReason).length, rejectedCount: fromSource.filter(job => Boolean(job.rejectionReason)).length };
  }
  const rejectionReasons: Record<string, number> = {};
  const sourceEligible = classified.filter(job => {
    if (job.rejectionReason) { rejectionReasons[job.rejectionReason] = (rejectionReasons[job.rejectionReason] ?? 0) + 1; return false; }
    return true;
  });
  const ledgerFiltered = excludeLedgerMatches(sourceEligible, exclusions);
  const { appliedExcluded, ineligibleExcluded, duplicateExcluded } = ledgerFiltered;
  const eligible = ledgerFiltered.kept;
  if (appliedExcluded) rejectionReasons.already_applied = appliedExcluded;
  if (ineligibleExcluded) rejectionReasons.ineligible = ineligibleExcluded;
  if (duplicateExcluded) rejectionReasons.duplicate = duplicateExcluded;
  const deduped = localDedupe(eligible);
  let digestJobs: DigestJob[] = deduped.unique;
  let batchKey: string | null = null;
  let shouldSend = false;
  let alreadySentRequisitions = 0;
  if (options.persistent) {
    if (notionReadSucceeded) await syncLedgerExclusions(exclusions);
    await recordSourceRuns(runId, sourceRuns);
    const stored = await Promise.all(deduped.unique.map(upsertJob));
    await closeStaleJobs();
    const unsentIds = await getUnsentJobIds(stored.map(item => item.job.id).filter((id): id is string => Boolean(id)));
    digestJobs = stored.map(item => item.job).filter(job => job.id && unsentIds.has(job.id));
    // Second line of defence, for the copy that got its own row: a requisition
    // already emailed is not news because a different list found it again.
    const sent = await getSentRequisitions([...new Set(digestJobs.map(job => job.normalizedCompany))]);
    const suppression = dropAlreadySentRequisitions(digestJobs, sent);
    digestJobs = suppression.kept;
    alreadySentRequisitions = suppression.suppressed;
    if (alreadySentRequisitions) {
      rejectionReasons.requisition_already_sent = alreadySentRequisitions;
      log('info', 'requisition_already_sent', { runId, suppressed: alreadySentRequisitions });
    }
  }
  // Highest score first, then cap. Whatever is left keeps sent_at NULL and is
  // picked up by the next tick, so a backlog drains over several readable
  // emails instead of one Gmail truncates while marking every role sent.
  const digestCandidates = digestJobs.length;
  if (options.persistent && config.ENRICHMENT_ENABLED && digestJobs.length) {
    // Enrich only what has never been resolved,
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
      applyEnrichment(job, verdict, priorities);
      return true;
    });
  }
  // A posting that says it cannot sponsor is reported rather than discarded.
  // The wording is the employer's boilerplate and not always the practice, and
  // some of these companies do sponsor, so the judgement belongs to the reader.
  // They ride in their own section under their own cap: 139 defense postings
  // must never be able to crowd out the roles that are open.
  // Collapse first, split second. Splitting first meant one requisition could
  // collapse twice, once inside each half, and print twice: RTX carries 19 rows
  // of the same Summer 2027 software internship across nine locations, 14 of
  // them reading UNKNOWN and 5 reading UNSUPPORTED because different sources
  // carry different evidence, so it appeared in the main section and again
  // under sponsorship with an identical title. A requisition is one row in one
  // email, whichever verdicts its copies disagree on.
  const allRequisitions = collapseByRequisition(digestJobs);
  const unlikely = allRequisitions.filter(group => group.display.sponsorshipStatus === 'UNSUPPORTED');
  const open = allRequisitions.filter(group => group.display.sponsorshipStatus !== 'UNSUPPORTED');
  // Group first, then cap, so the cap counts requisitions rather than spending
  // itself on one employer's six cities.
  // No early return on rows.length <= limit. The total cap is rarely the one
  // that binds - a digest of sixty rows is under it - and skipping the deal
  // when it does not bind skipped the per-employer ceiling with it.
  const capGroups = (rows: RequisitionGroup[], limit: number): RequisitionGroup[] => {
    const keep = new Set(diversifiedTop(rows.map(group => group.display), limit, config.DIGEST_MAX_ROLES_PER_COMPANY).map(job => job.canonicalKey));
    return rows.filter(group => keep.has(group.display.canonicalKey));
  };
  const groups = capGroups(open, config.DIGEST_MAX_ROLES);
  const unlikelyGroups = capGroups(unlikely, config.DIGEST_MAX_SPONSORSHIP_UNLIKELY);
  const allGroups = [...groups, ...unlikelyGroups];
  // Every member goes into the batch even though one row represents them, so
  // each city still gets sent_at stamped. Dropping them here would leave them
  // unsent and mail the whole family again on the next tick.
  digestJobs = allGroups.flatMap(group => group.members);
  if (digestCandidates > digestJobs.length) {
    log('info', 'digest_capped', { runId, sending: digestJobs.length, rows: allGroups.length, deferred: digestCandidates - digestJobs.length, sponsorshipUnlikely: unlikelyGroups.length });
  }
  // Last thing before the email is written, and only on the rows it will
  // print: identity is settled by now, and none of canonicalUrl, the canonical
  // key or the material fingerprint reads the apply link, so a row that gets a
  // better one is still the same row to dedupe and to the send state.
  const displayed = allGroups.map(group => group.display);
  if (options.persistent) await resolveListingLinks(displayed);
  const digest = buildDigest(displayed, sourceRuns, new Date(), programChanges);
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
  // Last, deliberately. Mirroring is a record of what the run found, so it must
  // not sit between finding a role and claiming the batch that emails it: at a
  // paced write per role this is the longest step in the run.
  let mirrored = 0;
  if (options.persistent) mirrored = (await mirrorNewPostings(runId)).created;
  log('info', 'pipeline_complete', { runId, raw: raw.length, eligible: eligible.length, digest: digestJobs.length, shouldSend, mirrored, dryRun: !options.persistent });
  return {
    runId, dryRun: !options.persistent, batchKey, shouldSend, emailTo: config.EMAIL_TO,
    subject: digestJobs.length ? digest.subject : null, html: digestJobs.length ? digest.html : null, text: digestJobs.length ? digest.text : null,
    jobs: digestJobs, sourceRuns: sourceRuns.map(run => ({ ...run, jobs: [], metrics: { ...(run.metrics ?? {}), fetchedCount: run.jobs.length } })),
    counts: { raw: raw.length, accepted: digestJobs.length, rejected: classified.length - eligible.length, deduplicated: deduped.count, appliedExcluded, ineligibleExcluded, duplicateExcluded },
    rejectionReasons, degradedSources: sourceRuns.filter(run => run.status !== 'SUCCESS').map(run => run.sourceName),
    notionExclusions: { source: notionExclusionSource, samples: ledgerFiltered.samples }, notionModified: mirrored > 0
  };
}

export async function runPipeline(options: RunOptions): Promise<PipelineReport> {
  return options.persistent ? withPipelineLock(() => execute(options)) : execute(options);
}
