import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

async function workflow(name: string): Promise<any> { return JSON.parse(await readFile(resolve(process.cwd(), 'workflows', name), 'utf8')); }

describe('exported n8n workflows', () => {
  it('has a two-hour inactive schedule, email guard, and batch confirmation', async () => {
    const value = await workflow('job-discovery-every-two-hours.json');
    expect(value.active).toBe(false);
    expect(value.nodes.find((node: any) => node.type.endsWith('scheduleTrigger')).parameters.rule.interval[0].hoursInterval).toBe(2);
    expect(value.nodes.some((node: any) => node.name === 'Has Claimed New Roles?')).toBe(true);
    expect(value.nodes.some((node: any) => node.name === 'Confirm Email Batch')).toBe(true);
    const gmail = value.nodes.find((node: any) => node.name === 'Send Gmail Digest');
    expect(gmail.parameters).toMatchObject({ operation: 'send', emailType: 'html' });
    expect(gmail.credentials).toBeUndefined();
    expect(JSON.stringify(value.connections['Has Claimed New Roles?'].main[0])).toContain('Send Gmail Digest');
    expect(JSON.stringify(value)).toContain('batch-sent');
  });

  // The one webhook that writes anywhere, and its two arguments are pasted into
  // a shell command. Dies if the character whitelist is ever loosened, or if the
  // command node is fed the query string directly rather than the validated node.
  it('validates the signed link before any value reaches a shell', async () => {
    const value = await workflow('mark-applied-webhook.json');
    // Exported inactive like the others; the entrypoint is what activates it,
    // because a webhook that is not active answers 404 and every Mark applied
    // link in every digest row is dead.
    expect(value.active).toBe(false);
    const entrypoint = await readFile(resolve(process.cwd(), 'scripts/railway-entrypoint.sh'), 'utf8');
    // --activeState takes "false" or "fromJson" and nothing else, and the
    // entrypoint runs under set -eu, so a rejected value would stop the
    // container from ever starting n8n.
    expect(entrypoint).not.toMatch(/--activeState=(?!false|fromJson)/);
    expect(entrypoint).toContain('n8n update:workflow --id=LakshMarkApplied --active=true');
    const validator = value.nodes.find((node: any) => node.name === 'Validate Signed Link');
    expect(validator.parameters.jsCode).toContain('[0-9a-f]{32}');
    expect(validator.parameters.jsCode).toContain('MARK_APPLIED_SECRET');
    const command = value.nodes.find((node: any) => node.name === 'Record Applied in Notion');
    expect(command.parameters.command).toContain('cli.js mark-applied');
    expect(command.parameters.command).toBe("=cd /opt/job-pipeline && node dist/cli.js mark-applied --job '{{ $json.job }}' --sig '{{ $json.sig }}'");
    expect(JSON.stringify(value.connections['Valid Signed Link?'].main[0])).toContain('Record Applied in Notion');
    expect(JSON.stringify(value.connections['Valid Signed Link?'].main[1])).toContain('Reject Safely');
  });

  it('keeps Rezzy separate, manual, secret-protected, and inactive', async () => {
    const value = await workflow('rezzy-shortlist-webhook.json');
    expect(value.active).toBe(false);
    expect(JSON.stringify(value)).toContain('REZZY_WEBHOOK_SECRET');
    expect(JSON.stringify(value)).toContain('rezzy_disabled');
    expect(JSON.stringify(value)).toContain('https://api.rezzy.dev/v1');
    expect(JSON.stringify(value)).toContain('/resume/create');
    expect(JSON.stringify(value)).toContain('job_description');
    expect(value.nodes.find((node: any) => node.name === 'Create Rezzy Draft').credentials).toBeUndefined();
  });
});
