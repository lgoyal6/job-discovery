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

  it('converts adapter exceptions into an isolated failed source result', async () => {
    class BrokenSource extends SafeSource {
      readonly name = 'broken-source';
      protected async collect(): Promise<never[]> { throw new Error('invalid external schema'); }
    }
    const result = await new BrokenSource().fetch();
    expect(result).toMatchObject({ sourceName: 'broken-source', status: 'FAILED', jobs: [], error: 'invalid external schema' });
  });
});
