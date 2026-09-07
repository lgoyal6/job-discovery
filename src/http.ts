import { log } from './logger.js';
import { BlockedDestinationError, guardedFetch } from './net-guard.js';

export interface FetchOptions extends RequestInit {
  timeoutMs: number;
  retries: number;
  sourceName: string;
  /**
   * Whether sending this request twice is harmless.
   *
   * Defaults to true for GET and HEAD and false for everything else, because a
   * retry is triggered by a lost answer and a lost answer says nothing about
   * whether the far end acted. The Discord audit posts a message with
   * retries: 1, so before this existed a timed-out send put two copies of the
   * audit in the channel.
   *
   * Workday and Phenom express a search as a POST. Those are reads wearing a
   * write's method, so they set this and keep the retries they need.
   */
  repeatable?: boolean;
}

// Sent only on a 403 retry, never on the first request: a source that works
// with the default agent should keep looking like what it is.
const BROWSER_HEADERS: Record<string, string> = {
  'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'accept-language': 'en-US,en;q=0.9'
};

export class HttpResponseError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'HttpResponseError';
  }
}

export async function fetchWithPolicy(url: string, options: FetchOptions): Promise<Response> {
  const { timeoutMs, retries, sourceName, repeatable, ...init } = options;
  const method = (typeof init.method === 'string' ? init.method : 'GET').toUpperCase();
  const mayRepeat = repeatable ?? (method === 'GET' || method === 'HEAD');
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await guardedFetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      if (response.ok) return response;
      // Carry the body into the message. A bare "HTTP 400" is undiagnosable:
      // Apify names the offending input field in the body and we were dropping
      // it, so two dead sources reported nothing but their status code.
      const detail = await response.text().then(body => body.replace(/\s+/g, ' ').trim().slice(0, 300)).catch(() => '');
      const status = `HTTP ${response.status}${detail ? `: ${detail}` : ''}`;
      // A 403 is a rejected client, not a missing page. Most corporate and bank
      // career sites serve browsers fine and refuse the default fetch user
      // agent, so retry once with browser headers before giving up.
      if (response.status === 403 && !init.headers && mayRepeat) {
        const browser = await guardedFetch(url, { ...init, headers: BROWSER_HEADERS, signal: AbortSignal.timeout(timeoutMs) });
        if (browser.ok) {
          log('info', 'source_403_recovered', { sourceName, url });
          return browser;
        }
      }
      if (response.status < 500 && response.status !== 429) throw new HttpResponseError(status, response.status);
      throw new HttpResponseError(`retryable ${status}`, response.status);
    } catch (error) {
      lastError = error;
      // A refused destination is not a flaky one: retrying it is three more
      // attempts to reach somewhere this pipeline is not allowed to reach.
      if ((error instanceof HttpResponseError && error.status < 500 && error.status !== 429)
          || error instanceof BlockedDestinationError) throw error;
      // The request may already have been acted on. Retrying a search costs an
      // extra read; retrying a message send costs a second message, and the
      // error is the same either way, so the method decides rather than the
      // error.
      if (!mayRepeat) {
        log('warn', 'source_write_not_retried', { sourceName, method, error: String(error) });
        break;
      }
      if (attempt === retries) break;
      const delayMs = Math.min(4000, 250 * 2 ** attempt) + Math.floor(Math.random() * 100);
      log('warn', 'source_retry', { sourceName, attempt: attempt + 1, delayMs, error: String(error) });
      await new Promise(resolveDelay => setTimeout(resolveDelay, delayMs));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
