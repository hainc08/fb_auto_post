/**
 * fetch with timeout + retry, and secret redaction for error messages.
 *
 * Retry policy (spec): max 2 retries, backoff 1s then 3s, only for
 * network errors, timeouts and HTTP 429/5xx. Other 4xx are returned as-is
 * (wrong token / missing permission won't fix themselves).
 */

export interface FetchRetryOptions {
  timeoutMs: number;
  /** Max retries after the first attempt (default 2). */
  retries?: number;
  /** Delay before each retry (default [1000, 3000]). */
  delaysMs?: number[];
  /**
   * Retry when the request timed out (default true). Set false for
   * non-idempotent calls (e.g. publishing a post) where the request may
   * have succeeded upstream even though we never saw the response.
   */
  retryOnTimeout?: boolean;
}

export class HttpTimeoutError extends Error {
  constructor(url: string, timeoutMs: number) {
    super(`Request timed out after ${timeoutMs / 1000}s (${safeHost(url)})`);
    this.name = 'HttpTimeoutError';
  }
}

export class HttpNetworkError extends Error {
  constructor(url: string, cause: unknown) {
    super(`Network error calling ${safeHost(url)}: ${redactSecrets((cause as Error)?.message ?? String(cause))}`);
    this.name = 'HttpNetworkError';
  }
}

const DEFAULT_DELAYS = [1000, 3000];

const isRetryableStatus = (status: number) => status === 429 || status >= 500;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  options: FetchRetryOptions
): Promise<Response> {
  const { timeoutMs, retries = 2, delaysMs = DEFAULT_DELAYS, retryOnTimeout = true } = options;

  for (let attempt = 0; ; attempt++) {
    const canRetry = attempt < retries;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, { ...init, signal: controller.signal });
      if (canRetry && isRetryableStatus(response.status)) {
        await response.body?.cancel();
      } else {
        return response;
      }
    } catch (error) {
      const timedOut = controller.signal.aborted;
      if (!canRetry || (timedOut && !retryOnTimeout)) {
        throw timedOut ? new HttpTimeoutError(url, timeoutMs) : new HttpNetworkError(url, error);
      }
    } finally {
      clearTimeout(timer);
    }

    await sleep(delaysMs[Math.min(attempt, delaysMs.length - 1)] ?? 0);
  }
}

// ─── Redaction ──────────────────────────────────

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/(access_token|input_token|fb_exchange_token|client_secret|key)=[^&\s"']+/gi, '$1=[REDACTED]'],
  [/(Bearer\s+)[A-Za-z0-9._\-]+/gi, '$1[REDACTED]'],
  [/\bEAA[A-Za-z0-9]{20,}\b/g, '[REDACTED]'], // Facebook tokens
  [/\bAIza[0-9A-Za-z_\-]{20,}\b/g, '[REDACTED]'], // Google API keys
];

/**
 * Remove tokens/secrets from a string before logging it or showing it in the UI.
 * `extraSecrets` are exact values (e.g. current API keys) to scrub as well.
 */
export function redactSecrets(text: string, extraSecrets: Array<string | undefined | null> = []): string {
  let out = text;
  for (const secret of extraSecrets) {
    if (secret && secret.length >= 6) out = out.split(secret).join('[REDACTED]');
  }
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'external service';
  }
}
