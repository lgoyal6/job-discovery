import { activeProfile } from './config.js';
import { markAppliedUrl } from './applied.js';
import { INVESTING_CATEGORIES } from './classification.js';
import type { DigestJob, SourceResult } from './types.js';

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
}

// A list that dates its rows by the day writes midnight UTC, and rendering that
// in Pacific time moves it to 5pm the previous day: every intern-list role was
// reported as posted a day before it was. A source that dates to the second
// (Greenhouse, Lever, Ashby) is worth the clock time, so the two are formatted
// differently and only the second one is converted.
const DAY_ONLY = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', year: 'numeric', month: 'short', day: 'numeric' });
const DAY_AND_TIME = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

function formatMoment(iso: string): string | undefined {
  const parsed = Date.parse(iso);
  // Workday reports "Posted 30+ Days Ago" and the pipeline used to carry that
  // string through to here, where it rendered as "Invalid Date". A value this
  // cannot read is not a date and must not be presented as one.
  if (Number.isNaN(parsed)) return undefined;
  return /T00:00:00(?:\.000)?Z$/.test(iso) ? DAY_ONLY.format(parsed) : DAY_AND_TIME.format(parsed);
}

/** What the digest prints on the "Posted" line, and what it sorts on. */
export function postedAtMillis(job: Pick<DigestJob, 'postedAt' | 'firstSeenAt'>): number {
  // NaN is falsy, so an unreadable date falls through to the next candidate
  // rather than poisoning the comparison it is used in.
  return Date.parse(job.postedAt ?? '') || Date.parse(job.firstSeenAt ?? '') || 0;
}

export function postedLabel(job: Pick<DigestJob, 'postedAt' | 'firstSeenAt'>): string {
  const posted = job.postedAt ? formatMoment(job.postedAt) : undefined;
  if (posted) return posted;
  const seen = job.firstSeenAt ? formatMoment(job.firstSeenAt) : undefined;
  // Said plainly, because the two are not the same claim: the employer did not
  // date this posting, and what is being reported is when this pipeline first
  // saw it.
  return seen ? `Not stated by the source, first seen ${seen}` : 'Not stated by the source, first seen today';
}

// Both links point at the same page on every ATS board, where the posting and
// its application form are one URL. Rendering that twice as "Source" and
// "Direct application" is what made the digest look like it carried two links
// per role and one of them broken.
function applyLinks(job: DigestJob): Array<{ label: string; url: string }> {
  const apply = job.directApplyUrl ?? job.sourceUrl;
  const links = [{ label: 'Apply', url: apply }];
  if (job.sourceUrl && job.sourceUrl !== apply) links.push({ label: 'Listing', url: job.sourceUrl });
  return links;
}

function roleHtml(job: DigestJob): string {
  const skills = job.requiredSkills.length ? job.requiredSkills.join(', ') : 'Not stated';
  const applied = markAppliedUrl(job.id);
  const links = applyLinks(job).map(link => `<a href="${escapeHtml(link.url)}">${link.label}</a>`).join(' · ');
  return `<li style="margin-bottom:18px"><strong>${escapeHtml(job.company)} - ${escapeHtml(job.title)}</strong><br>
    ${escapeHtml(job.cycle)} · ${escapeHtml(job.location ?? 'Unspecified')} · ${escapeHtml(job.category)} · score ${job.score}<br>
    Posted: ${escapeHtml(postedLabel(job))} · Source: ${escapeHtml(job.sourceName)}<br>
    Sponsorship: <strong>${job.sponsorshipStatus}</strong> - ${escapeHtml(job.sponsorshipEvidence)}<br>
    ${links}${applied ? ` · <a href="${escapeHtml(applied)}">Mark applied</a>` : ''}<br>
    ${escapeHtml(job.summary)}<br><em>Required skills:</em> ${escapeHtml(skills)}</li>`;
}

function roleText(job: DigestJob): string {
  const applied = markAppliedUrl(job.id);
  return [
    `${job.company} - ${job.title}`,
    `${job.cycle} | ${job.location ?? 'Unspecified'} | ${job.category} | score ${job.score}`,
    `Posted: ${postedLabel(job)} | Source: ${job.sourceName}`,
    `Sponsorship: ${job.sponsorshipStatus} - ${job.sponsorshipEvidence}`,
    ...applyLinks(job).map(link => `${link.label}: ${link.url}`),
    ...(applied ? [`Mark applied: ${applied}`] : []),
    `Summary: ${job.summary}`,
    `Required skills: ${job.requiredSkills.join(', ') || 'Not stated'}`
  ].join('\n');
}

/**
 * How each digest is divided, and in what order its rows are read.
 *
 * The technical digest is sorted by score and split by sponsorship, because its
 * reader wants the best match first and the sponsorship answer is what decides
 * whether a role is worth an application at all.
 *
 * The finance digest is sorted newest first and split by what the job actually
 * is. Its reader asked for exactly three sections: the roles that invest money
 * or research what to invest in, the plain finance roles kept separately so the
 * corporate-finance tail can never dilute the first section, and last the roles
 * that state a sponsorship or citizenship requirement, carried only so that
 * nothing found is silently dropped.
 */
function sectionsFor(sorted: DigestJob[]): Array<[string, DigestJob[]]> {
  if (activeProfile !== 'finance') {
    return [
      ['Strong Summer 2027 matches', sorted.filter(job => job.cycle === 'Summer 2027' && job.sponsorshipStatus === 'SUPPORTED')],
      ['Other target-cycle matches', sorted.filter(job => job.cycle !== 'Summer 2027' && job.sponsorshipStatus === 'SUPPORTED')],
      ['Sponsorship unclear', sorted.filter(job => job.sponsorshipStatus === 'UNKNOWN')],
      // Last, and labelled for what it is. The posting says no; employers do
      // depart from that boilerplate, and the evidence line on each row is there
      // so the call can be made without opening the posting.
      ['Says no sponsorship, decide for yourself', sorted.filter(job => job.sponsorshipStatus === 'UNSUPPORTED')]
    ];
  }
  const open = sorted.filter(job => job.sponsorshipStatus !== 'UNSUPPORTED');
  return [
    ['Investing', open.filter(job => INVESTING_CATEGORIES.has(job.category))],
    ['Finance', open.filter(job => !INVESTING_CATEGORIES.has(job.category))],
    ['Sponsorship or citizenship required (listed so nothing is missed)', sorted.filter(job => job.sponsorshipStatus === 'UNSUPPORTED')]
  ];
}

function sortForDigest(jobs: DigestJob[]): DigestJob[] {
  // Newest first for finance, which is what its reader asked for: an
  // application window that opened today outranks a better-scoring role that
  // has been public for three weeks. Score still breaks ties, so rows posted on
  // the same day are ordered by how well they match.
  if (activeProfile === 'finance') {
    return [...jobs].sort((a, b) => postedAtMillis(b) - postedAtMillis(a) || b.score - a.score || a.company.localeCompare(b.company));
  }
  return [...jobs].sort((a, b) => b.score - a.score || a.company.localeCompare(b.company));
}

export interface ProgramChange { company: string; label: string; url: string }

export function buildDigest(jobs: DigestJob[], sourceRuns: SourceResult[], timestamp = new Date(), programChanges: ProgramChange[] = []): { subject: string; html: string; text: string } {
  const sorted = sortForDigest(jobs);
  const sections = sectionsFor(sorted);
  const degraded = sourceRuns.filter(run => run.status !== 'SUCCESS').map(run => `${run.sourceName}: ${run.error ?? run.status}`);
  const displayTime = timestamp.toLocaleString('en-US', { timeZone: 'America/Los_Angeles', dateStyle: 'medium', timeStyle: 'short' });
  // A change with no new roles still deserves its own subject: an email titled
  // "0 roles" reads as noise and gets ignored, which defeats the point of
  // watching for an announcement weeks before the requisition exists.
  const subject = jobs.length
    ? `${activeProfile === 'finance' ? 'New finance internships and analyst roles' : 'New technical internships'}: ${jobs.length} roles, ${displayTime}`
    : `Program page updates: ${programChanges.length} changed, ${displayTime}`;
  const htmlSections = sections.filter(([, items]) => items.length).map(([name, items]) => `<h2>${name}</h2><ol>${items.map(roleHtml).join('')}</ol>`).join('');
  const changeHtml = programChanges.length
    ? `<h2>Program page updates</h2><ul>${programChanges.map(change => `<li><a href="${escapeHtml(change.url)}">${escapeHtml(change.company)}</a>${change.label ? ` - ${escapeHtml(change.label)}` : ''}</li>`).join('')}</ul>`
    : '';
  const failureHtml = degraded.length ? `<h2>Source failures or degraded coverage</h2><ul>${degraded.map(value => `<li>${escapeHtml(value)}</li>`).join('')}</ul>` : '';
  const textSections = sections.filter(([, items]) => items.length).map(([name, items]) => `${name}\n${'='.repeat(name.length)}\n\n${items.map(roleText).join('\n\n')}`).join('\n\n');
  const changeText = programChanges.length
    ? `\n\nProgram page updates\n${programChanges.map(change => `- ${change.company}${change.label ? ` (${change.label})` : ''}: ${change.url}`).join('\n')}`
    : '';
  const failureText = degraded.length ? `\n\nSource failures or degraded coverage\n${degraded.map(value => `- ${value}`).join('\n')}` : '';
  const ledgerNote = activeProfile === 'finance' ? '' : ' Notion was read for applied exclusions and was not modified.';
  return {
    subject,
    html: `<main><p>${jobs.length} genuinely new eligible role${jobs.length === 1 ? '' : 's'} found.${ledgerNote}</p>${htmlSections}${changeHtml}${failureHtml}</main>`,
    text: `${jobs.length} genuinely new eligible role(s) found.${ledgerNote}\n\n${textSections}${changeText}${failureText}`
  };
}
