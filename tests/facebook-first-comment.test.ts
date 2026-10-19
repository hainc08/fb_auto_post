import { describe, it, expect, vi } from 'vitest';
import { FacebookClient, FacebookApiError } from '../src/lib/clients/facebook';

const TOKEN = 'EAAfaketokenfirstcommentxxxxxxxxxxxx';
const client = () => new FacebookClient({ appId: '123', appSecret: 'fake-secret', graphVersion: 'v23.0' }, [TOKEN]);
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe('FacebookClient.createComment (first comment)', () => {
  it('posts the message as a comment under the post, once, with the Page token', async () => {
    const fetch = vi.fn(async () => json({ id: 'P_1_C_9' }));
    vi.stubGlobal('fetch', fetch);
    const res = await client().createComment('P_1', TOKEN, 'Link: https://example.com/a');
    expect(res).toEqual({ id: 'P_1_C_9' });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(new URL(url).pathname).toBe('/v23.0/P_1/comments');
    const body = new URLSearchParams(String(init.body));
    expect(body.get('message')).toBe('Link: https://example.com/a');
    expect(body.get('access_token')).toBe(TOKEN);
    expect(init.method).toBe('POST');
  });

  it('a refused comment is a FacebookApiError with Facebook\'s message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: { message: '(#200) Permissions error', code: 200 } }, 400)));
    await expect(client().createComment('P_1', TOKEN, 'x')).rejects.toBeInstanceOf(FacebookApiError);
    await expect(client().createComment('P_1', TOKEN, 'x')).rejects.toThrow(/Permissions error/);
  });
});
