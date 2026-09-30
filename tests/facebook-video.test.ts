import { describe, it, expect, vi } from 'vitest';
import { FacebookClient } from '../src/lib/clients/facebook';

const TOKEN = 'EAAfaketokenvideotestxxxxxxxxxxxxxx';
const client = () => new FacebookClient({ appId: '123', appSecret: 'fake-secret', graphVersion: 'v23.0' }, [TOKEN]);
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const video = () => ({ blob: new Blob([Buffer.alloc(32, 1)], { type: 'video/mp4' }), size: 32, mime: 'video/mp4' });

describe('FacebookClient video publishing', () => {
  it('publishVideo uploads to graph-video with the caption as description', async () => {
    const fetch = vi.fn(async () => json({ id: 'VID1' }));
    vi.stubGlobal('fetch', fetch);
    const res = await client().publishVideo('PAGE1', TOKEN, video(), 'Chào bà con');
    expect(res).toEqual({ postId: 'VID1', videoId: 'VID1' });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://graph-video.facebook.com/v23.0/PAGE1/videos');
    const form = init.body as FormData;
    expect(form.get('description')).toBe('Chào bà con');
    expect(form.get('access_token')).toBe(TOKEN);
    expect(form.get('source')).toBeInstanceOf(Blob);
  });

  it('publishReel runs start → upload → finish', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json({ video_id: 'REEL1', upload_url: 'https://rupload.facebook.com/video-upload/v23.0/REEL1' }))
      .mockResolvedValueOnce(json({ success: true }))
      .mockResolvedValueOnce(json({ success: true }));
    vi.stubGlobal('fetch', fetch);
    const res = await client().publishReel('PAGE1', TOKEN, video(), 'Reel mới');
    expect(res).toEqual({ postId: 'REEL1', videoId: 'REEL1' });

    const [startUrl, startInit] = fetch.mock.calls[0] as [string, RequestInit];
    expect(startUrl).toBe('https://graph.facebook.com/v23.0/PAGE1/video_reels');
    expect(String(startInit.body)).toContain('upload_phase=start');

    const [upUrl, upInit] = fetch.mock.calls[1] as [string, RequestInit];
    expect(upUrl).toBe('https://rupload.facebook.com/video-upload/v23.0/REEL1');
    expect(upInit.headers).toMatchObject({ Authorization: `OAuth ${TOKEN}`, offset: '0', file_size: '32' });

    const [, finishInit] = fetch.mock.calls[2] as [string, RequestInit];
    const finish = new URLSearchParams(String(finishInit.body));
    expect(finish.get('upload_phase')).toBe('finish');
    expect(finish.get('video_id')).toBe('REEL1');
    expect(finish.get('video_state')).toBe('PUBLISHED');
    expect(finish.get('description')).toBe('Reel mới');
  });

  it('a failed Reel upload stops before publishing', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(json({ video_id: 'REEL2' })).mockResolvedValueOnce(json({ success: false }));
    vi.stubGlobal('fetch', fetch);
    await expect(client().publishReel('PAGE1', TOKEN, video(), 'x')).rejects.toThrow(/Reels/);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('video permalinks (relative) become absolute', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ permalink_url: '/PAGE1/videos/VID1/' })));
    expect(await client().getPermalink('VID1', TOKEN)).toBe('https://www.facebook.com/PAGE1/videos/VID1/');
  });
});
