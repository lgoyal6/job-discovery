import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchWithPolicy } from '../src/http.js';
import { SafeSource } from '../src/sources/base.js';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('HTTP reliability policy', () => {
  it('retries retryable responses with exponential backoff', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const mockedFetch = vi.fn()
      .mockResolvedValueOnce(new Response('busy', { status: 503 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', mockedFetch);

    const pending = fetchWithPolicy('https://source.test/jobs', { sourceName: 'test', timeoutMs: 1_000, retries: 2 });
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toBeInstanceOf(Response);
    expect(mockedFetch).toHaveBeenCalledTimes(2);
  });

  it('does not retry a non-rate-limited 4xx response', async () => {
    const mockedFetch = vi.fn().mockResolvedValue(new Response('bad request', { status: 400 }));
    vi.stubGlobal('fetch', mockedFetch);
    await expect(fetchWithPolicy('https://source.test/jobs', { sourceName: 'test', timeoutMs: 1_000, retries: 3 })).rejects.toThrow('HTTP 400');
    expect(mockedFetch).toHaveBeenCalledOnce();
  });

  it('reports why a request failed, not just the status code', async () => {
    // The digest showed "apify:linkedin: HTTP 400" and nothing else, so the
    // reason Apify rejected the run was unreadable from the email.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{\n  "error": {\n    "message": "Input is not valid: field count is not allowed"\n  }\n}', { status: 400 })));
    await expect(fetchWithPolicy('https://api.apify.test/run', { sourceName: 'apify:linkedin', timeoutMs: 1_000, retries: 0 }))
      .rejects.toThrow('HTTP 400: { "error": { "message": "Input is not valid: field count is not allowed" } }');
  });

  it('truncates a long error body so one failure cannot flood the digest', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('x'.repeat(5_000), { status: 400 })));
    const error = await fetchWithPolicy('https://source.test/jobs', { sourceName: 'test', timeoutMs: 1_000, retries: 0 }).catch((caught: Error) => caught);
    expect((error as Error).message).toHaveLength('HTTP 400: '.length + 300);
  });

  it('converts adapter exceptions into an isolated failed source result', async () => {
    class BrokenSource extends SafeSource {
      readonly name = 'broken-source';
      protected async collect(): Promise<never[]> { throw new Error('invalid external schema'); }
    }
    const result = await new BrokenSource().fetch();
    expect(result).toMatchObject({ sourceName: 'broken-source', status: 'FAILED', jobs: [], error: 'invalid external schema' });
  });
});
