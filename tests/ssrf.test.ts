import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadSponsorshipPatterns } from '../src/config.js';
import { enrichSponsorship } from '../src/enrichment.js';
import { fetchWithPolicy } from '../src/http.js';
import { assertAllowedUrl, BlockedDestinationError, guardedFetch, isBlockedAddress, readCappedText, ResponseTooLargeError } from '../src/net-guard.js';
import { checkWatchedPages } from '../src/sources/pagewatch.js';
import type { DigestJob } from '../src/types.js';

/**
 * Every apply URL in this pipeline is written by somebody else. The community
 * lists are public READMEs anyone can open a pull request against, intern-list
 * is scraped markup, and Apify returns whatever the actor found. Enrichment
 * then fetches that URL from inside whatever network the pipeline runs in, so
 * "http://169.254.169.254/latest/meta-data/" in a table cell is a request to
 * the host's credential endpoint, made by us, with our routing.
 *
 * These fixtures are local servers rather than recorded responses because the
 * thing under test is whether a socket opens at all. A recorded response cannot
 * fail to be reached.
 */

const servers: Server[] = [];

async function listen(handler: (url: string, response: import('node:http').ServerResponse) => void): Promise<{ port: number; hits: string[] }> {
  const hits: string[] = [];
  const server = createServer((request, response) => {
    hits.push(request.url ?? '');
    handler(request.url ?? '', response);
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { port: (server.address() as AddressInfo).port, hits };
}

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve))));
});

// Long enough to clear enrichment's 400-character "nothing to classify" floor,
// so a page that is reached produces a real verdict rather than a shrug.
const STOLEN = `AccessKeyId ASIAINTERNALFAKE SecretAccessKey ${'s'.repeat(500)}`;

const posting = (url: string): DigestJob => ({
  id: '11111111-1111-1111-1111-111111111111',
  title: 'Software Engineer Intern',
  directApplyUrl: url,
  canonicalUrl: url
}) as DigestJob;

describe('destinations an apply URL is allowed to reach', () => {
  it('does not open a socket to a loopback service a list names as an apply link', async () => {
    const internal = await listen((_url, response) => response.end(STOLEN));
    const [verdict] = await enrichSponsorship(
      [posting(`http://127.0.0.1:${internal.port}/latest/meta-data/iam/security-credentials/`)],
      await loadSponsorshipPatterns()
    );
    expect(internal.hits).toEqual([]);
    expect(verdict?.httpOk).toBe(false);
    expect(verdict?.summary).not.toContain('SecretAccessKey');
  });

  it('does not reach a private address behind a name, which reading the URL cannot catch', async () => {
    // localhost is a name, not a literal, so only resolving it says where it
    // goes. Same shape as an attacker-controlled record pointing at
    // 169.254.169.254, and it needs no DNS server to demonstrate.
    const internal = await listen((_url, response) => response.end(STOLEN));
    const [verdict] = await enrichSponsorship(
      [posting(`http://localhost:${internal.port}/admin/keys`)],
      await loadSponsorshipPatterns()
    );
    expect(internal.hits).toEqual([]);
    expect(verdict?.httpOk).toBe(false);
  });

  it('refuses a redirect chain whose entry point is already private', async () => {
    // This one stops at the first hop, which is the honest description of what
    // it proves. The hop-by-hop check is exercised in the redirect block below,
    // where the chain can start somewhere the policy actually allows.
    const internal = await listen((_url, response) => response.end(STOLEN));
    const entry = await listen((_url, response) => {
      response.writeHead(302, { location: `http://127.0.0.1:${internal.port}/latest/meta-data/` });
      response.end();
    });
    const [verdict] = await enrichSponsorship(
      [posting(`http://127.0.0.1:${entry.port}/jobs/4408102238`)],
      await loadSponsorshipPatterns()
    );
    expect(internal.hits).toEqual([]);
    expect(verdict?.httpOk).toBe(false);
  });

  it('refuses a watched page that resolves to the machine the pipeline runs on', async () => {
    const internal = await listen((_url, response) => response.end(`<html><body>${'x'.repeat(1000)}</body></html>`));
    const [result] = await checkWatchedPages([{ url: `http://127.0.0.1:${internal.port}/program`, company: 'Internal', label: '' }]);
    expect(internal.hits).toEqual([]);
    expect(result?.hash).toBe('');
    expect(result?.error).toBeTruthy();
  });

  it('refuses a configured source URL that resolves to a private address', async () => {
    const internal = await listen((_url, response) => response.end('[]'));
    await expect(fetchWithPolicy(`http://127.0.0.1:${internal.port}/jobs`, { sourceName: 'test', timeoutMs: 2_000, retries: 0 }))
      .rejects.toThrow();
    expect(internal.hits).toEqual([]);
  });

  it('still fetches a source that is not on a private address', async () => {
    // The guard is only worth having if the pipeline still works, so this is
    // the control: nothing here is in a blocked range and it must go through.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('[{"id":1}]', { status: 200 })));
    const response = await fetchWithPolicy('https://boards-api.greenhouse.io/v1/boards/imc/jobs', { sourceName: 'greenhouse:imc', timeoutMs: 2_000, retries: 0 });
    expect(await response.text()).toBe('[{"id":1}]');
  });
});

describe('addresses the policy names', () => {
  it('refuses the ranges that are ours, the network\'s, or nobody\'s', () => {
    for (const address of [
      '127.0.0.1', '169.254.169.254', '10.1.2.3', '172.16.0.5', '192.168.1.1', '100.64.1.1',
      '0.0.0.0', '255.255.255.255', '::1', 'fe80::1', 'fc00::1',
      // A v4 address wearing a v6 hat still goes to the same place.
      '::ffff:127.0.0.1', '::ffff:169.254.169.254', '64:ff9b::7f00:1', '2002:7f00:1::1'
    ]) expect(isBlockedAddress(address), address).toBe(true);
  });

  it('allows the public internet, including the edge of a blocked range', () => {
    for (const address of ['8.8.8.8', '13.107.42.14', '172.32.0.1', '99.83.190.102', '2606:4700::1111'])
      expect(isBlockedAddress(address), address).toBe(false);
  });

  it('refuses a scheme that is not a web request', () => {
    for (const url of ['file:///etc/passwd', 'gopher://127.0.0.1:70/', 'ftp://files.example.com/x', 'data:text/html,hi'])
      expect(() => assertAllowedUrl(url), url).toThrow(BlockedDestinationError);
    expect(assertAllowedUrl('https://boards.greenhouse.io/imc').hostname).toBe('boards.greenhouse.io');
  });
});

describe('a redirect hop is checked before it is made', () => {
  it('refuses the second hop without issuing it', async () => {
    // The transport is stubbed here so the assertion is about the decision: a
    // hop to a literal address must be refused before a request goes out, and
    // a literal never reaches the lookup hook that catches names.
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: URL | string) => {
      calls.push(String(input));
      return new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data/' } });
    }));
    await expect(guardedFetch('https://boards.greenhouse.io/imc/jobs/1')).rejects.toThrow(/169\.254\.169\.254 is not a public address/);
    expect(calls).toEqual(['https://boards.greenhouse.io/imc/jobs/1']);
  });

  it('takes the hops itself rather than letting the transport take them', async () => {
    // The check above stubs a transport that never follows anything, so it
    // passes whether or not guardedFetch asks for manual redirects. This one
    // models what fetch actually does when it is left to follow: it walks
    // Location on its own, consulting no policy, and a hop to a literal address
    // reaches no lookup hook either. So the moment redirects stop being taken
    // here, the metadata body is what comes back.
    const reached: string[] = [];
    const metadata = 'http://169.254.169.254/latest/meta-data/iam/security-credentials/';
    vi.stubGlobal('fetch', vi.fn(async (input: URL | string, init: RequestInit = {}) => {
      let url = String(input);
      for (let hop = 0; hop < 5; hop += 1) {
        reached.push(url);
        if (url === metadata) return new Response(STOLEN, { status: 200 });
        const redirect = new Response(null, { status: 302, headers: { location: metadata } });
        if (init.redirect === 'manual') return redirect;
        url = metadata;
      }
      throw new Error('too many redirects');
    }));
    await expect(guardedFetch('https://boards.greenhouse.io/imc/jobs/1')).rejects.toThrow(BlockedDestinationError);
    // The metadata endpoint is absent from this list, which is the assertion.
    expect(reached).toEqual(['https://boards.greenhouse.io/imc/jobs/1']);
  });

  it('does not hand a credential to the host a redirect names', async () => {
    // Node drops authorization and cookie itself but keeps everything else:
    // measured, x-api-key survived a cross-origin redirect. Following the hops
    // here makes that ours to get right.
    const sent: Array<Record<string, string>> = [];
    vi.stubGlobal('fetch', vi.fn(async (_input: URL | string, init: RequestInit) => {
      sent.push(Object.fromEntries(new Headers(init.headers).entries()));
      return sent.length === 1
        ? new Response(null, { status: 302, headers: { location: 'https://cdn.elsewhere.example/jobs/1' } })
        : new Response('ok', { status: 200 });
    }));
    await guardedFetch('https://boards.greenhouse.io/imc/jobs/1', {
      headers: { authorization: 'Bearer secret', cookie: 'session=abc', 'x-api-key': 'k', 'user-agent': 'laksh-job-discovery/1.0' }
    });
    expect(sent[0]).toMatchObject({ authorization: 'Bearer secret', 'x-api-key': 'k' });
    expect(Object.keys(sent[1] ?? {}).sort()).toEqual(['user-agent']);
  });

  it('keeps a same-host redirect intact, which is how boards paginate', async () => {
    const sent: Array<Record<string, string>> = [];
    vi.stubGlobal('fetch', vi.fn(async (_input: URL | string, init: RequestInit) => {
      sent.push(Object.fromEntries(new Headers(init.headers).entries()));
      return sent.length === 1
        ? new Response(null, { status: 302, headers: { location: 'https://boards.greenhouse.io/imc/jobs/1/' } })
        : new Response('ok', { status: 200 });
    }));
    const response = await guardedFetch('https://boards.greenhouse.io/imc/jobs/1', { headers: { authorization: 'Bearer secret' } });
    expect(await response.text()).toBe('ok');
    expect(sent[1]).toMatchObject({ authorization: 'Bearer secret' });
  });
});

describe('what a fetched body is allowed to cost', () => {
  it('gives up on a posting that expands into tens of megabytes', async () => {
    // 30 MB of one byte compresses to about 30 KB, so the wire cost is nothing
    // and the heap cost is the whole point. content-length is absent, so only
    // counting decoded bytes as they arrive catches this.
    const bomb = gzipSync(Buffer.alloc(30 * 1024 * 1024, 0x41));
    const server = await listen((_url, response) => {
      response.writeHead(200, { 'content-encoding': 'gzip', 'content-type': 'text/html' });
      response.end(bomb);
    });
    const response = await fetch(`http://127.0.0.1:${server.port}/posting`);
    await expect(readCappedText(response, 1_048_576)).rejects.toThrow(ResponseTooLargeError);
  }, 30_000);

  it('reads a posting that fits', async () => {
    const server = await listen((_url, response) => response.end('<p>Software Engineer Intern</p>'));
    const response = await fetch(`http://127.0.0.1:${server.port}/posting`);
    expect(await readCappedText(response, 1_048_576)).toBe('<p>Software Engineer Intern</p>');
  });
});
