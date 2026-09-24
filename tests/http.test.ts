import { describe, it, expect, vi } from 'vitest';
import { fetchWithRetry, redactSecrets, HttpTimeoutError, HttpNetworkError } from '../src/lib/http';

const NO_DELAY = { delaysMs: [0, 0] };
const res = (status: number, body = '{}') => new Response(body, { status });

function mockFetch(...results: Array<Response | Error | 'hang'>) {
  const fn = vi.fn((_url: string, init?: RequestInit) => {
    const next = results.shift();
    if (next === 'hang') {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    }
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next!);
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

describe('fetchWithRetry', () => {
  it('returns first successful response', async () => {
    const fetch = mockFetch(res(200));
    const r = await fetchWithRetry('https://x.test', {}, { timeoutMs: 1000, ...NO_DELAY });
    expect(r.status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('retries 429 and 5xx up to 2 times', async () => {
    const fetch = mockFetch(res(429), res(503), res(200));
    const r = await fetchWithRetry('https://x.test', {}, { timeoutMs: 1000, ...NO_DELAY });
    expect(r.status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('returns the last 5xx when retries are exhausted', async () => {
    const fetch = mockFetch(res(500), res(502), res(503));
    const r = await fetchWithRetry('https://x.test', {}, { timeoutMs: 1000, ...NO_DELAY });
    expect(r.status).toBe(503);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('does not retry other 4xx', async () => {
    const fetch = mockFetch(res(401), res(200));
    const r = await fetchWithRetry('https://x.test', {}, { timeoutMs: 1000, ...NO_DELAY });
    expect(r.status).toBe(401);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('retries network errors then throws HttpNetworkError', async () => {
    const fetch = mockFetch(new TypeError('fetch failed'), new TypeError('fetch failed'), new TypeError('fetch failed'));
    await expect(fetchWithRetry('https://x.test', {}, { timeoutMs: 1000, ...NO_DELAY })).rejects.toBeInstanceOf(
      HttpNetworkError
    );
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('times out and retries by default', async () => {
    const fetch = mockFetch('hang', res(200));
    const r = await fetchWithRetry('https://x.test', {}, { timeoutMs: 20, ...NO_DELAY });
    expect(r.status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('does not retry timeouts when retryOnTimeout=false (non-idempotent publish)', async () => {
    const fetch = mockFetch('hang', res(200));
    await expect(
      fetchWithRetry('https://x.test', {}, { timeoutMs: 20, retryOnTimeout: false, ...NO_DELAY })
    ).rejects.toBeInstanceOf(HttpTimeoutError);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('waits 1s then 3s between retries by default', async () => {
    vi.useFakeTimers();
    try {
      const fetch = mockFetch(res(500), res(500), res(200));
      const p = fetchWithRetry('https://x.test', {}, { timeoutMs: 60_000 });
      await vi.advanceTimersByTimeAsync(999);
      expect(fetch).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(fetch).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(2999);
      expect(fetch).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      expect((await p).status).toBe(200);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('redactSecrets', () => {
  it('removes token query params, bearer tokens, FB and Google keys', () => {
    const text =
      'GET /debug_token?input_token=EAAabc&access_token=123|secret Authorization: Bearer cf_abc.def ' +
      'EAAXumK8p65cBSnsZA2n1ujmZBmFv3J8Uwck AIzaSyA1234567890abcdefghijk';
    const out = redactSecrets(text);
    expect(out).not.toMatch(/EAAabc|123\|secret|cf_abc|EAAXum|AIzaSy/);
    expect(out).toContain('input_token=[REDACTED]');
    expect(out).toContain('Bearer [REDACTED]');
  });

  it('removes explicitly provided secrets', () => {
    expect(redactSecrets('error for key my-plain-secret', ['my-plain-secret'])).toBe('error for key [REDACTED]');
  });
});
