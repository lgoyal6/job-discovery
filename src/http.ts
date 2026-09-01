import { log } from './logger.js';

export interface FetchOptions extends RequestInit {
  timeoutMs: number;
  retries: number;
  sourceName: string;
}

// Sent only on a 403 retry, never on the first request: a source that works
// with the default agent should keep looking like what it is.
const BROWSER_HEADERS: Record<string, string> = {
  'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'accept-language': 'en-US,en;q=0.9'
};

class NonRetryableHttpError extends Error {}

export async function fetchWithPolicy(url: string, options: FetchOptions): Promise<Response> {
  const { timeoutMs, retries, sourceName, ...init } = options;
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      if (response.ok) return response;
      // Carry the body into the message. A bare "HTTP 400" is undiagnosable:
      // Apify names the offending input field in the body and we were dropping
      // it, so two dead sources reported nothing but their status code.
      const detail = await response.text().then(body => body.replace(/\s+/g, ' ').trim().slice(0, 300)).catch(() => '');
      const status = `HTTP ${response.status}${detail ? `: ${detail}` : ''}`;
      // A 403 is a rejected client, not a missing page. Most corporate and bank
      // career sites serve browsers fine and refuse the default fetch user
      // agent, so retry once with browser headers before giving up.
      if (response.status === 403 && !init.headers) {
        const browser = await fetch(url, { ...init, headers: BROWSER_HEADERS, signal: AbortSignal.timeout(timeoutMs) });
        if (browser.ok) {
          log('info', 'source_403_recovered', { sourceName, url });
          return browser;
        }
      }
      if (response.status < 500 && response.status !== 429) throw new NonRetryableHttpError(status);
      throw new Error(`retryable ${status}`);
    } catch (error) {
      lastError = error;
      if (error instanceof NonRetryableHttpError) throw error;
      if (attempt === retries) break;
      const delayMs = Math.min(4000, 250 * 2 ** attempt) + Math.floor(Math.random() * 100);
      log('warn', 'source_retry', { sourceName, attempt: attempt + 1, delayMs, error: String(error) });
      await new Promise(resolveDelay => setTimeout(resolveDelay, delayMs));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
