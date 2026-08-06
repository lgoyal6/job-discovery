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
