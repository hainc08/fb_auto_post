import { describe, it, expect, vi } from 'vitest';
import { FacebookClient, FacebookApiError, isPermissionError } from '../src/lib/clients/facebook';

const TOKEN = 'EAAfaketokenengagementxxxxxxxxxxxxx';
const client = () => new FacebookClient({ appId: '123', appSecret: 'fake-secret', graphVersion: 'v23.0' }, [TOKEN]);
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe('FacebookClient engagement and comments', () => {
  it('getEngagement reads counts for many posts in one call, shares default to 0', async () => {
    const fetch = vi.fn(async () =>
      json({
        P_1: { id: 'P_1', reactions: { summary: { total_count: 38 } }, comments: { summary: { total_count: 12 } }, shares: { count: 4 } },
        P_2: { id: 'P_2', reactions: { summary: { total_count: 0 } }, comments: { summary: { total_count: 0 } } },
      })
    );
    vi.stubGlobal('fetch', fetch);
    const res = await client().getEngagement(['P_1', 'P_2'], TOKEN);
    expect(res).toEqual({ P_1: { reactions: 38, comments: 12, shares: 4 }, P_2: { reactions: 0, comments: 0, shares: 0 } });
    const url = new URL(String((fetch.mock.calls[0] as unknown as [string])[0]));
    expect(url.searchParams.get('ids')).toBe('P_1,P_2');
    expect(url.searchParams.get('fields')).toContain('reactions.summary(total_count)');
  });

  it('getEngagement splits more than 50 posts into several calls', async () => {
    const fetch = vi.fn(async (input: string) => {
      const ids = new URL(input).searchParams.get('ids')!.split(',');
      return json(Object.fromEntries(ids.map((id) => [id, { id, reactions: { summary: { total_count: 1 } }, comments: { summary: { total_count: 0 } } }])));
    });
    vi.stubGlobal('fetch', fetch);
    const ids = Array.from({ length: 120 }, (_, i) => `P_${i}`);
    const res = await client().getEngagement(ids, TOKEN);
    expect(Object.keys(res)).toHaveLength(120);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('getComments asks for top-level comments, newest first, with their replies', async () => {
    const fetch = vi.fn(async () => json({ data: [{ id: 'C1', message: 'Có workflow mẫu không?', created_time: '2026-09-30T01:00:00+0000', from: { id: 'U1', name: 'An' } }] }));
    vi.stubGlobal('fetch', fetch);
    const res = await client().getComments('P_1', TOKEN);
    expect(res[0].id).toBe('C1');
    const url = new URL(String((fetch.mock.calls[0] as unknown as [string])[0]));
    expect(url.pathname).toMatch(/\/P_1\/comments$/);
    expect(url.searchParams.get('filter')).toBe('toplevel');
    expect(url.searchParams.get('order')).toBe('reverse_chronological');
    expect(url.searchParams.get('fields')).toContain('comments.limit(25)');
  });

  it('replyToComment posts once and returns the new comment id', async () => {
    const fetch = vi.fn(async () => json({ id: 'C1_R1' }));
    vi.stubGlobal('fetch', fetch);
    expect(await client().replyToComment('C1', TOKEN, 'Có nhé!')).toEqual({ id: 'C1_R1' });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/C1\/comments$/);
    expect(new URLSearchParams(String(init.body)).get('message')).toBe('Có nhé!');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('recognises permission errors', () => {
    expect(isPermissionError(new FacebookApiError('x', 10))).toBe(true);
    expect(isPermissionError(new FacebookApiError('x', 200))).toBe(true);
    expect(isPermissionError(new FacebookApiError('x', 190))).toBe(false);
    expect(isPermissionError(new Error('x'))).toBe(false);
  });
});
