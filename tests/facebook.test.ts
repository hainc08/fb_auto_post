import { describe, it, expect, vi } from 'vitest';
import { FacebookClient, FacebookApiError } from '../src/lib/clients/facebook';

const SECRET = 'app-secret-should-not-leak';
const SHORT = 'EAAshortLivedUserToken1234567890abcdef';
const client = (appSecret = SECRET) => new FacebookClient({ appId: '123', appSecret, graphVersion: 'v23.0' }, [appSecret]);

const graphError = (code: number, message: string, subcode?: number) =>
  new Response(JSON.stringify({ error: { message, code, error_subcode: subcode, fbtrace_id: 'TRACE1' } }), { status: 400 });

describe('FacebookClient.exchangeLongLivedUserToken', () => {
  it('fails fast without calling Facebook when App Secret is missing', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await expect(client('').exchangeLongLivedUserToken(SHORT)).rejects.toThrow(/App ID \/ App Secret/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('maps code 101 (invalid app) to a Vietnamese hint about App ID vs Page ID', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => graphError(101, 'Error validating application.')));
    const error = (await client().exchangeLongLivedUserToken(SHORT).catch((e) => e)) as FacebookApiError;
    expect(error).toBeInstanceOf(FacebookApiError);
    expect(error.message).toMatch(/không phải ID của Page/);
    expect(error.errorCode).toBe('code 101 · trace TRACE1');
  });

  it('maps expired tokens (190/463) and never leaks secrets', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => graphError(190, `Session has expired for ${SHORT} with ${SECRET}`, 463)));
    const error = (await client().exchangeLongLivedUserToken(SHORT).catch((e) => e)) as FacebookApiError;
    expect(error.message).toMatch(/hết hạn/);
    expect(`${error.message} ${error.rawMessage}`).not.toMatch(new RegExp(`${SHORT}|${SECRET}`));
  });

  it('returns the long-lived token on success', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ access_token: 'EAAlong' }), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    await expect(client().exchangeLongLivedUserToken(SHORT)).resolves.toBe('EAAlong');
    const url = new URL(fetch.mock.calls[0][0] as string);
    expect(url.pathname).toBe('/v23.0/oauth/access_token');
    expect(url.searchParams.get('grant_type')).toBe('fb_exchange_token');
  });
});

describe('FacebookClient.debugToken with a token from another app', () => {
  it('explains that the Page token must be re-issued with the current app', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => graphError(100, '(#100) The App_id in the input_token did not match the Viewing App')));
    const error = (await client().debugToken('EAApagetokenfromoldapp1234567890').catch((e) => e)) as FacebookApiError;
    expect(error.message).toMatch(/App khác cấp/);
    expect(error.message).toMatch(/Đổi token dài hạn/);
    expect(error.retryable).toBe(false);
  });

  it('keeps the generic message for other code-100 errors', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => graphError(100, 'Invalid parameter')));
    const error = (await client().debugToken('EAAsomething1234567890abcdefgh').catch((e) => e)) as FacebookApiError;
    expect(error.message).toMatch(/Tham số gửi lên Facebook không hợp lệ/);
  });
});
