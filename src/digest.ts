import type { DigestJob, SourceResult } from './types.js';

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
}

function roleHtml(job: DigestJob): string {
  const posted = job.postedAt ? new Date(job.postedAt).toLocaleDateString('en-US', { timeZone: 'America/Los_Angeles' }) : job.firstSeenAt ? new Date(job.firstSeenAt).toLocaleDateString('en-US') : 'First seen today';
  const skills = job.requiredSkills.length ? job.requiredSkills.join(', ') : 'Not stated';
  const direct = job.directApplyUrl ? `<a href="${escapeHtml(job.directApplyUrl)}">Direct application</a>` : 'No separate direct URL';
  return `<li style="margin-bottom:18px"><strong>${escapeHtml(job.company)} — ${escapeHtml(job.title)}</strong><br>
    ${escapeHtml(job.cycle)} · ${escapeHtml(job.location ?? 'Unspecified')} · ${escapeHtml(job.category)} · score ${job.score}<br>
    Sponsorship: <strong>${job.sponsorshipStatus}</strong> — ${escapeHtml(job.sponsorshipEvidence)}<br>
    Posted/first seen: ${escapeHtml(posted)} · Source: ${escapeHtml(job.sourceName)}<br>
    <a href="${escapeHtml(job.sourceUrl)}">Source</a> · ${direct}<br>
    ${escapeHtml(job.summary)}<br><em>Required skills:</em> ${escapeHtml(skills)}</li>`;
}

function roleText(job: DigestJob): string {
  return [
    `${job.company} — ${job.title}`,
    `${job.cycle} | ${job.location ?? 'Unspecified'} | ${job.category} | score ${job.score}`,
    `Sponsorship: ${job.sponsorshipStatus} — ${job.sponsorshipEvidence}`,
    `Source: ${job.sourceName} — ${job.sourceUrl}`,
    `Direct apply: ${job.directApplyUrl ?? 'Not available separately'}`,
    `Summary: ${job.summary}`,
    `Required skills: ${job.requiredSkills.join(', ') || 'Not stated'}`
  ].join('\n');
}

export function buildDigest(jobs: DigestJob[], sourceRuns: SourceResult[], timestamp = new Date()): { subject: string; html: string; text: string } {
  const sorted = [...jobs].sort((a, b) => b.score - a.score || a.company.localeCompare(b.company));
  const sections: Array<[string, DigestJob[]]> = [
    ['Strong Summer 2027 matches', sorted.filter(job => job.cycle === 'Summer 2027' && job.sponsorshipStatus === 'SUPPORTED')],
    ['Other target-cycle matches', sorted.filter(job => job.cycle !== 'Summer 2027' && job.sponsorshipStatus === 'SUPPORTED')],
    ['Sponsorship unclear', sorted.filter(job => job.sponsorshipStatus === 'UNKNOWN')]
  ];
  const degraded = sourceRuns.filter(run => run.status !== 'SUCCESS').map(run => `${run.sourceName}: ${run.error ?? run.status}`);
  const displayTime = timestamp.toLocaleString('en-US', { timeZone: 'America/Los_Angeles', dateStyle: 'medium', timeStyle: 'short' });
  const subject = `New technical internships: ${jobs.length} roles — ${displayTime}`;
  const htmlSections = sections.filter(([, items]) => items.length).map(([name, items]) => `<h2>${name}</h2><ol>${items.map(roleHtml).join('')}</ol>`).join('');
  const failureHtml = degraded.length ? `<h2>Source failures or degraded coverage</h2><ul>${degraded.map(value => `<li>${escapeHtml(value)}</li>`).join('')}</ul>` : '';
  const textSections = sections.filter(([, items]) => items.length).map(([name, items]) => `${name}\n${'='.repeat(name.length)}\n\n${items.map(roleText).join('\n\n')}`).join('\n\n');
  const failureText = degraded.length ? `\n\nSource failures or degraded coverage\n${degraded.map(value => `- ${value}`).join('\n')}` : '';
  return {
    subject,
    html: `<main><p>${jobs.length} genuinely new eligible role${jobs.length === 1 ? '' : 's'} found. Notion was read for applied exclusions and was not modified.</p>${htmlSections}${failureHtml}</main>`,
    text: `${jobs.length} genuinely new eligible role(s) found. Notion was not modified.\n\n${textSections}${failureText}`
  };
}
