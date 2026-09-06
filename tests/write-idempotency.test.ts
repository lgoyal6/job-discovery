import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchWithPolicy } from '../src/http.js';

/**
 * A retry is only free when repeating the request is free.
 *
 * fetchWithPolicy retries on any thrown error, and a timeout is thrown after
 * the request has already gone out. For a search that is nothing: ask twice,
 * get the same postings. For the Discord audit, which posts a message with
 * retries: 1, it is a second message in the channel, because the failure that
 * triggered the retry says nothing about whether the server acted on the first
 * one. That is the case these fakes model: the server records the write and
 * then the response is lost.
 *
 * Nothing here reaches a real service. The transport is a fake that counts what
 * it was asked to do.
 */

afterEach(() => { vi.unstubAllGlobals(); });

/**
 * A transport where the far end always accepts the write and the answer never
 * comes back. Every entry in `accepted` is a side effect that really happened.
 */
function lossyTransport(accepted: string[]): void {
  vi.stubGlobal('fetch', vi.fn(async (_input: URL | string, init: RequestInit = {}) => {
    accepted.push(String(init.body ?? ''));
    throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
  }));
}

describe('a write is not repeated just because its answer was lost', () => {
  it('posts the audit message once when the response times out after the server took it', async () => {
    const accepted: string[] = [];
    lossyTransport(accepted);
    await expect(fetchWithPolicy('https://discord.com/api/v10/channels/1/messages', {
      sourceName: 'discord-audit', timeoutMs: 50, retries: 1, method: 'POST',
      headers: { authorization: 'Bot token', 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'Job discovery audit' })
    })).rejects.toThrow();
    // One message in the channel, not two.
    expect(accepted).toHaveLength(1);
  });

  it('does not repeat a POST on a 500 either, which is equally ambiguous', async () => {
    const accepted: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_input: URL | string, init: RequestInit = {}) => {
      accepted.push(String(init.body ?? ''));
      return new Response('upstream exploded', { status: 500 });
    }));
    await expect(fetchWithPolicy('https://discord.com/api/v10/channels/1/messages', {
      sourceName: 'discord-audit', timeoutMs: 50, retries: 3, method: 'POST', body: '{"content":"x"}'
    })).rejects.toThrow();
    expect(accepted).toHaveLength(1);
  });

  it('still retries a GET, because asking twice costs nothing', async () => {
    // The guard must not cost the pipeline its resilience: a flaky board is the
    // reason retries exist.
    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls += 1;
      if (calls < 3) throw new Error('socket hang up');
      return new Response('[{"id":1}]', { status: 200 });
    }));
    const response = await fetchWithPolicy('https://boards-api.greenhouse.io/v1/boards/imc/jobs', {
      sourceName: 'greenhouse:imc', timeoutMs: 50, retries: 3
    });
    expect(await response.text()).toBe('[{"id":1}]');
    expect(calls).toBe(3);
  });

  it('still retries a POST the caller has declared repeatable, which is how the ATS searches work', async () => {
    // Workday and Phenom express a search as a POST. Repeating it returns the
    // same page of postings and changes nothing at the far end, so those call
    // sites opt in and keep the retries they have always had.
    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls += 1;
      if (calls < 2) throw new Error('socket hang up');
      return new Response('{"jobPostings":[]}', { status: 200 });
    }));
    const response = await fetchWithPolicy('https://acme.wd1.myworkdayjobs.com/wday/cxs/acme/careers/jobs', {
      sourceName: 'workday:acme', timeoutMs: 50, retries: 3, method: 'POST', repeatable: true,
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ limit: 20, offset: 0 })
    });
    expect(await response.text()).toBe('{"jobPostings":[]}');
    expect(calls).toBe(2);
  });

  it('does not re-issue a POST as the 403 browser-header recovery', async () => {
    // The 403 path re-sends the request with browser headers. For a GET that is
    // a second read; for a POST it is a second write.
    const accepted: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_input: URL | string, init: RequestInit = {}) => {
      accepted.push(String(init.body ?? ''));
      return new Response('forbidden', { status: 403 });
    }));
    await expect(fetchWithPolicy('https://discord.com/api/v10/channels/1/messages', {
      sourceName: 'discord-audit', timeoutMs: 50, retries: 0, method: 'POST', body: '{"content":"x"}'
    })).rejects.toThrow();
    expect(accepted).toHaveLength(1);
  });
});
