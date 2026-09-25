import { describe, it, expect, vi } from 'vitest';
import { FacebookApiError, FacebookClient, TokenDebugInfo } from '../src/lib/clients/facebook';
import { blockMessage, blockReason, classifyInspectError, classifyToken, withPostable } from '../src/lib/page-health';

const NEW_APP = '1111111111';
const OLD_APP = '2222222222';

const info = (over: Partial<TokenDebugInfo> = {}): TokenDebugInfo => ({
  isValid: true,
  type: 'PAGE',
  appId: NEW_APP,
  expiresAt: null,
  dataAccessExpiresAt: null,
  scopes: ['pages_manage_posts', 'pages_read_engagement', 'pages_show_list'],
  missingScopes: [],
  ...over,
});

const page = (over: Record<string, unknown> = {}) => ({
  isActive: true,
  tokenStatus: 'VALID' as const,
  tokenAppId: NEW_APP,
  missingScopes: [] as string[],
  ...over,
});

describe('classifyToken', () => {
  it('is VALID for a Page token of the current app with every permission', () => {
    expect(classifyToken(info(), NEW_APP)).toMatchObject({ tokenStatus: 'VALID', tokenAppId: NEW_APP });
  });

  it('is OTHER_APP when another app issued the token, and remembers which one', () => {
    expect(classifyToken(info({ appId: OLD_APP }), NEW_APP)).toMatchObject({ tokenStatus: 'OTHER_APP', tokenAppId: OLD_APP });
  });

  it('reports missing permissions', () => {
    const check = classifyToken(info({ missingScopes: ['pages_manage_posts'] }), NEW_APP);
    expect(check).toMatchObject({ tokenStatus: 'MISSING_PERMISSIONS', missingScopes: ['pages_manage_posts'] });
  });

  it('flags user tokens stored in place of Page tokens', () => {
    expect(classifyToken(info({ type: 'USER' }), NEW_APP).tokenStatus).toBe('ERROR');
  });

  it('keeps the expiry date', () => {
    expect(classifyToken(info({ expiresAt: '2026-11-24T00:00:00.000Z' }), NEW_APP).tokenExpiresAt?.toISOString()).toBe('2026-11-24T00:00:00.000Z');
  });
});

describe('classifyInspectError', () => {
  it('maps 190/463 to EXPIRED and other 190 to REVOKED', () => {
    expect(classifyInspectError(new FacebookApiError('x', 190, 463)).tokenStatus).toBe('EXPIRED');
    expect(classifyInspectError(new FacebookApiError('x', 190, 460)).tokenStatus).toBe('REVOKED');
  });

  it('treats network trouble as ERROR (unknown, not a reason to block)', () => {
    expect(classifyInspectError(new Error('socket hang up')).tokenStatus).toBe('ERROR');
  });
});

describe('blockReason', () => {
  it('lets a healthy Page of the current app through', () => {
    expect(blockReason(page(), NEW_APP)).toBeNull();
  });

  it('blocks as soon as the App ID in Settings changes, without re-checking', () => {
    expect(blockReason(page({ tokenAppId: OLD_APP }), NEW_APP)).toBe('OTHER_APP');
  });

  it('unblocks an OTHER_APP Page if Settings go back to that app', () => {
    expect(blockReason(page({ tokenStatus: 'OTHER_APP', tokenAppId: OLD_APP }), OLD_APP)).toBeNull();
  });

  it('blocks disconnected, expired, revoked and under-permitted Pages', () => {
    expect(blockReason(page({ isActive: false }), NEW_APP)).toBe('DISCONNECTED');
    expect(blockReason(page({ tokenStatus: 'EXPIRED' }), NEW_APP)).toBe('EXPIRED');
    expect(blockReason(page({ tokenStatus: 'REVOKED' }), NEW_APP)).toBe('REVOKED');
    expect(blockReason(page({ tokenStatus: 'MISSING_PERMISSIONS' }), NEW_APP)).toBe('MISSING_PERMISSIONS');
  });

  it('does not block when the token was never checked or the check failed', () => {
    expect(blockReason(page({ tokenStatus: 'UNCHECKED', tokenAppId: null }), NEW_APP)).toBeNull();
    expect(blockReason(page({ tokenStatus: 'ERROR' }), NEW_APP)).toBeNull();
  });
});

describe('withPostable / blockMessage', () => {
  it('explains in Vietnamese what to do', () => {
    const p = withPostable(page({ tokenAppId: OLD_APP }), NEW_APP);
    expect(p).toMatchObject({ postable: false, blockReason: 'OTHER_APP' });
    expect(p.blockMessage).toMatch(new RegExp(`App khác cấp \\(${OLD_APP}\\).*đồng bộ lại`));
    expect(blockMessage('MISSING_PERMISSIONS', page({ missingScopes: ['pages_manage_posts'] }))).toMatch(/pages_manage_posts/);
  });
});

describe('FacebookClient.inspectOwnToken', () => {
  it('uses the token itself as access token (no App Secret needed) and reads its app', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ data: { is_valid: true, type: 'PAGE', app_id: OLD_APP, scopes: [] } }), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    const fb = new FacebookClient({ appId: '', appSecret: '', graphVersion: 'v23.0' });

    const result = await fb.inspectOwnToken('EAApagetoken1234567890abcdef');
    expect(result.appId).toBe(OLD_APP);
    const url = new URL(fetch.mock.calls[0][0] as unknown as string);
    expect(url.searchParams.get('access_token')).toBe('EAApagetoken1234567890abcdef');
    expect(url.searchParams.get('input_token')).toBe('EAApagetoken1234567890abcdef');
  });
});
