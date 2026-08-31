import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

async function workflow(name: string): Promise<any> { return JSON.parse(await readFile(resolve(process.cwd(), 'workflows', name), 'utf8')); }

describe('exported n8n workflows', () => {
  it('ships an inactive six-hour finance digest that runs under its own profile', async () => {
    const value = await workflow('finance-digest-every-six-hours.json');
    expect(value.active).toBe(false);
    expect(value.id).not.toBe('LakshJobDiscovery2h');
    expect(value.nodes.find((node: any) => node.type.endsWith('scheduleTrigger')).parameters.rule.interval[0].hoursInterval).toBe(6);
    // Both commands, not just the pipeline: batch-sent writes the send state and
    // under this profile it has to write the finance database, not the technical
    // one. The two runs hold advisory locks in separate databases, so the offset
    // minute is about the container's CPU and network rather than the lock.
    const commands = value.nodes.filter((node: any) => node.type.endsWith('executeCommand')).map((node: any) => node.parameters.command);
    expect(commands).toHaveLength(2);
    for (const command of commands) expect(command).toContain('JOB_PROFILE=finance');
    // The entrypoint is what puts this workflow in n8n at all, and what keeps
    // the finance database on the same ordered migrations as the technical one.
    const entrypoint = await readFile(resolve(process.cwd(), 'scripts/railway-entrypoint.sh'), 'utf8');
    expect(entrypoint).toContain('workflows/finance-digest-every-six-hours.json');
    expect(entrypoint).toContain('JOB_PROFILE=finance node dist/cli.js migrate');
    expect(value.nodes.find((node: any) => node.type.endsWith('scheduleTrigger')).parameters.rule.interval[0].triggerAtMinute).toBe(37);
    expect(value.nodes.find((node: any) => node.name === 'Send Gmail Digest').credentials).toBeUndefined();
  });

  it('keeps the failure alert inside the length Discord will accept', async () => {
    // Every alert for eighteen hours was rejected with
    //   400 {"message":"Invalid Form Body","code":50035,
    //        "errors":{"content":{"_errors":[{"code":"BASE_TYPE_MAX_LENGTH",
    //                  "message":"Must be 4000 or fewer in length."}]}}}
    // because the message embedded the pipeline's whole stderr, which is 10,933
    // characters on a real failure: seventy-odd source_complete lines, the one
    // line that matters, and a stack. So the digest failed and the thing whose
    // job it was to say so failed too, silently.
    const value = await workflow('job-discovery-error-alert.json');
    const body: string = value.nodes.find((node: any) => node.name === 'DM Discord').parameters.jsonBody;
    expect(body).toContain('slice(0, 3800)');
    // The noise is dropped before the tail is taken, or the eight lines kept
    // would all be source_complete and the actual error would not survive.
    expect(body).toContain('source_complete');

    // Run what the node runs, against a failure shaped like the real one.
    const noise = Array.from({ length: 70 }, (_, index) =>
      `{"timestamp":"2026-08-21T15:07:${String(index).padStart(2, '0')}.472Z","level":"info","event":"source_complete","source":"board-${index}","fetched":184}`);
    const failure = '{"level":"error","event":"cli_failed","error":"duplicate key value violates unique constraint"}';
    const message = [...noise, failure, ...Array.from({ length: 6 }, (_, index) => `    at frame${index}`)].join('\n');
    const json = { workflow: { name: 'Laksh Job Discovery' }, execution: { id: 353, lastNodeExecuted: 'Run Deterministic Pipeline', error: { message } } };
    const rendered = new Function('$json', `return ${body.replace(/^=\{\{/, '').replace(/\}\}$/, '')}`)(json);
    const content = JSON.parse(rendered).content as string;

    expect(message.length).toBeGreaterThan(4000);
    expect(content.length).toBeLessThanOrEqual(4000);
    expect(content).toContain('cli_failed');
    expect(content).not.toContain('source_complete');

    // A single unbroken line cannot be split, so the final clamp is what has to
    // hold, and it is the one guarantee that matters here.
    const oneLine = new Function('$json', `return ${body.replace(/^=\{\{/, '').replace(/\}\}$/, '')}`)({ workflow: { name: 'W' }, execution: { id: 1, error: { message: 'x'.repeat(50_000) } } });
    expect((JSON.parse(oneLine).content as string).length).toBeLessThanOrEqual(4000);

    // Imported by the entrypoint now, and activated, because nothing imported it
    // before: the deployed copy and this one were free to drift, and they did.
    const entrypoint = await readFile(resolve(process.cwd(), 'scripts/railway-entrypoint.sh'), 'utf8');
    expect(entrypoint).toContain('workflows/job-discovery-error-alert.json');
    expect(entrypoint).toContain('--id=LakshJobDiscoveryErrorAlert --active=true');
    // Outside the N8N_IMPORT_WORKFLOWS_ON_START guard, which is false in
    // production: inside it, this import would never run and the deployed alert
    // would go on differing from this one. There has to be a closing `fi`
    // between the guard and the import for that to be true.
    const guard = entrypoint.indexOf('if [ "${N8N_IMPORT_WORKFLOWS_ON_START');
    const alertImport = entrypoint.indexOf('workflows/job-discovery-error-alert.json');
    expect(guard).toBeGreaterThan(-1);
    expect(alertImport).toBeGreaterThan(guard);
    expect(entrypoint.slice(guard, alertImport)).toContain('\nfi\n');
  });

  it('has a three-hour inactive schedule, email guard, and batch confirmation', async () => {
    const value = await workflow('job-discovery-every-three-hours.json');
    expect(value.active).toBe(false);
    expect(value.nodes.find((node: any) => node.type.endsWith('scheduleTrigger')).parameters.rule.interval[0].hoursInterval).toBe(3);
    expect(value.nodes.some((node: any) => node.name === 'Has Claimed New Roles?')).toBe(true);
    expect(value.nodes.some((node: any) => node.name === 'Confirm Email Batch')).toBe(true);
    const gmail = value.nodes.find((node: any) => node.name === 'Send Gmail Digest');
    expect(gmail.parameters).toMatchObject({ operation: 'send', emailType: 'html' });
    expect(gmail.credentials).toBeUndefined();
    expect(JSON.stringify(value.connections['Has Claimed New Roles?'].main[0])).toContain('Send Gmail Digest');
    expect(JSON.stringify(value)).toContain('batch-sent');
  });

  // Execution 372 claimed a batch with nothing rendered in it: shouldSend was
  // true while subject, html and text were all null, so the gate opened and the
  // Gmail node died on "Cannot read properties of null (reading 'trim')". The
  // send was already claimed by then. A claimed batch with no digest has to stop
  // at the gate, where stopping costs nothing, not at the node that mails it.
  it('refuses to open the send gate without a rendered subject', async () => {
    for (const name of ['job-discovery-every-three-hours.json', 'finance-digest-every-six-hours.json']) {
      const value = await workflow(name);
      const gate = value.nodes.find((node: any) => node.name === 'Has Claimed New Roles?');
      expect(gate.parameters.conditions.combinator).toBe('and');
      const conditions = gate.parameters.conditions.conditions;
      expect(conditions).toHaveLength(2);
      const subject = conditions.find((condition: any) => condition.leftValue.includes('subject'));
      expect(subject.operator).toMatchObject({ type: 'string', operation: 'notEmpty' });
      // Coalesced to a string, because typeValidation is strict: a null subject
      // has to evaluate false and skip the send, not raise on the gate itself
      // and trade a bad digest for a failed run.
      expect(gate.parameters.conditions.options.typeValidation).toBe('strict');
      expect(subject.leftValue).toContain("?? ''");
    }
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
