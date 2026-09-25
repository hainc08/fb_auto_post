import { describe, it, expect, vi } from 'vitest';
import { UnrecoverableJobError } from '../src/lib/job-queue';
import { FacebookClient, FacebookApiError } from '../src/lib/clients/facebook';
import { HttpNetworkError, HttpTimeoutError } from '../src/lib/http';
import { classifyFailure } from '../src/lib/job-failure';

const PAGE_TOKEN = 'EAApageToken1234567890abcdefghij';
const client = new FacebookClient({ appId: '123', appSecret: 'secret', graphVersion: 'v23.0' }, [PAGE_TOKEN]);
const image = { buffer: Buffer.from([0xff, 0xd8, 0xff, 0xe0]), mime: 'image/jpeg' };

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe('FacebookClient publishing', () => {
  it('uploads the photo with its message and returns the feed post id', async () => {
    const fetch = vi.fn(async () => json({ id: 'PHOTO1', post_id: 'PAGE_POST1' }));
    vi.stubGlobal('fetch', fetch);

    const result = await client.publishPhoto('PAGE', PAGE_TOKEN, image, 'Xin chào');

    expect(result).toEqual({ postId: 'PAGE_POST1', photoId: 'PHOTO1' });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(new URL(url).pathname).toBe('/v23.0/PAGE/photos');
    const form = init.body as FormData;
    expect(form.get('message')).toBe('Xin chào');
    expect(form.get('source')).toBeInstanceOf(Blob);
  });

  it('never retries a publish on 5xx (Facebook may already have posted)', async () => {
    const fetch = vi.fn(async () => json({ error: { message: 'Service unavailable', code: 2 } }, 503));
    vi.stubGlobal('fetch', fetch);

    const error = (await client.publishText('PAGE', PAGE_TOKEN, 'Hi').catch((e) => e)) as FacebookApiError;
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(error).toBeInstanceOf(FacebookApiError);
    expect(error.retryable).toBe(true);
  });

  it('does not leak the page token in errors', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: { message: `Bad token ${PAGE_TOKEN}`, code: 190 } }, 400)));
    const error = (await client.publishText('PAGE', PAGE_TOKEN, 'Hi').catch((e) => e)) as FacebookApiError;
    expect(error.retryable).toBe(false);
    expect(`${error.message} ${error.rawMessage}`).not.toContain(PAGE_TOKEN);
  });

  it('getPermalink returns undefined instead of failing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: { message: 'x', code: 100 } }, 400)));
    await expect(client.getPermalink('POST', PAGE_TOKEN)).resolves.toBeUndefined();
  });
});

describe('classifyFailure', () => {
  it('does not retry a timeout while publishing, and warns about a possible duplicate', () => {
    const failure = classifyFailure(new HttpTimeoutError('https://graph.facebook.com/x', 60_000), 'publish_facebook');
    expect(failure.retryable).toBe(false);
    expect(failure.message).toMatch(/kiểm tra Page/);
  });

  it('retries network errors in steps that are safe to repeat', () => {
    expect(classifyFailure(new HttpNetworkError('https://x.test', new Error('ECONNRESET')), 'generate_image').retryable).toBe(true);
  });

  it('retries Facebook rate limits but not token errors', () => {
    expect(classifyFailure(new FacebookApiError('rate', 4), 'publish_facebook').retryable).toBe(true);
    const token = classifyFailure(new FacebookApiError('token', 190, 463, 'TR'), 'publish_facebook');
    expect(token).toMatchObject({ retryable: false, code: 'code 190/463 · trace TR' });
  });

  it('keeps UnrecoverableJobError final', () => {
    expect(classifyFailure(new UnrecoverableJobError('no content'), 'compose_fields')).toEqual({ message: 'no content', retryable: false });
  });
});
