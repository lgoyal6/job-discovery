import { activeProfile, config } from './config.js';
import { fetchWithPolicy } from './http.js';
import { log } from './logger.js';
import type { NotionMatchBasis, PipelineReport } from './types.js';

const MAX_CONTENT_LENGTH = 1800;
const basisLabels: Record<NotionMatchBasis, string> = {
  SOURCE_JOB_ID: 'job ID',
  CANONICAL_URL: 'URL',
  COMPANY_TITLE: 'company/title'
};

function oneLine(value: string, maxLength: number): string {
  return Array.from(value.replace(/\s+/g, ' ').trim()).slice(0, maxLength).join('');
}

export function renderDiscordAudit(report: PipelineReport): string {
  const counts = report.counts;
  const totalExcluded = counts.appliedExcluded + counts.ineligibleExcluded + counts.duplicateExcluded;
  const source = report.notionExclusions.source === 'LIVE_NOTION'
    ? 'live'
    : report.notionExclusions.source === 'CACHE'
      ? 'cache'
      : 'none';
  const lines = [
    '**Job discovery audit**',
    `Run: ${report.runId.slice(0, 8)} | Notion: ${source}`,
    `Found: ${counts.raw} | Digest candidates: ${counts.accepted} | Email batch: ${report.shouldSend ? 'claimed' : 'not claimed'}`,
    `Notion-suppressed postings: ${totalExcluded}`,
    `Applied: ${counts.appliedExcluded} | Ineligible: ${counts.ineligibleExcluded} | Duplicate: ${counts.duplicateExcluded}`,
    '',
    '**Samples**'
  ];
  if (!report.notionExclusions.samples.length) lines.push('- None this run');
  else for (const sample of report.notionExclusions.samples) {
    lines.push(`- ${sample.kind} | ${oneLine(sample.company, 70)} | ${oneLine(sample.title, 110)} | ${basisLabels[sample.matchBasis]}`);
  }
  lines.push('', `Degraded sources: ${report.degradedSources.length}`);
  return Array.from(lines.join('\n')).slice(0, MAX_CONTENT_LENGTH).join('');
}

export async function sendDiscordAudit(report: PipelineReport): Promise<'SENT' | 'SKIPPED' | 'FAILED'> {
  if (activeProfile !== 'technical') return 'SKIPPED';
  if (!config.DISCORD_DM_CHANNEL_ID || !config.DISCORD_BOT_TOKEN) {
    log('warn', 'discord_audit_skipped', { runId: report.runId, reason: 'not_configured' });
    return 'SKIPPED';
  }
  try {
    await fetchWithPolicy(`https://discord.com/api/v10/channels/${config.DISCORD_DM_CHANNEL_ID}/messages`, {
      sourceName: 'discord-audit', timeoutMs: 5000, retries: 1, method: 'POST',
      headers: { authorization: `Bot ${config.DISCORD_BOT_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ content: renderDiscordAudit(report), allowed_mentions: { parse: [] } })
    });
    log('info', 'discord_audit_sent', { runId: report.runId });
    return 'SENT';
  } catch (error) {
    log('warn', 'discord_audit_failed', { runId: report.runId, error: error instanceof Error ? error.message : String(error) });
    return 'FAILED';
  }
}
