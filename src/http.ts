import { log } from './logger.js';

export interface FetchOptions extends RequestInit {
  timeoutMs: number;
  retries: number;
  sourceName: string;
}

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
