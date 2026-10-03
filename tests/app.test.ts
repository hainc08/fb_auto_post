import { describe, it, expect, afterAll, beforeAll, vi } from 'vitest';
import * as selfCheck from '../src/lib/reel/self-check';
import { createApp } from '../src/app';
import { startTestServer, api } from './helpers/http';

let server: Awaited<ReturnType<typeof startTestServer>>;
beforeAll(async () => { server = await startTestServer(createApp()); });
afterAll(() => server.close());

describe('createApp', () => {
  it('serves the API index without touching the database', async () => {
    const res = await api(server.baseUrl, 'GET', '/api');
    expect(res.status).toBe(200);
    expect(res.json.name).toBe('Auto Post Facebook API');
  });

  it('lets the Vite dev client (5173) send cookies', async () => {
    const res = await fetch(`${server.baseUrl}/api`, { headers: { Origin: 'http://localhost:5173' } });
    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
    expect(res.headers.get('access-control-allow-credentials')).toBe('true');
  });

  it('never asks for a site-wide Basic Auth password, even when the old variables are still set', async () => {
    process.env.BASIC_AUTH_USER = 'admin';
    process.env.BASIC_AUTH_PASS = 'old-gate-password';
    const gated = await startTestServer(createApp());
    try {
      const res = await api(gated.baseUrl, 'GET', '/api');
      expect(res.status).toBe(200);
      expect(res.headers.get('www-authenticate')).toBeNull();
      // The app's own login still guards the data
      expect((await api(gated.baseUrl, 'GET', '/api/posts')).status).toBe(401);
    } finally {
      delete process.env.BASIC_AUTH_USER;
      delete process.env.BASIC_AUTH_PASS;
      await gated.close();
    }
  });

  it('checks the cron key on /cron/tick', async () => {
    process.env.CRON_SECRET = 'cron-key-for-test';
    try {
      expect((await api(server.baseUrl, 'GET', '/cron/tick')).status).toBe(401);
      expect((await api(server.baseUrl, 'GET', '/cron/tick?key=wrong')).status).toBe(401);
    } finally {
      delete process.env.CRON_SECRET;
    }
    expect((await api(server.baseUrl, 'GET', '/cron/tick?key=cron-key-for-test')).status).toBe(404);
  });

  it('/cron/reel-check needs the cron key and returns the check, or the sample video', async () => {
    const check = { ok: true, problems: [], ffmpeg: 'ffmpeg version 7', font: 'BeVietnamPro-Bold', voice: { ms: 1, words: 6, bytes: 3 }, render: { ms: 2, durationSec: 4, width: 1080, height: 1920, bytes: 9 }, file: Buffer.from('....ftypvideo') };
    const run = vi.spyOn(selfCheck, 'reelSelfCheck').mockResolvedValue(check);
    expect((await api(server.baseUrl, 'GET', '/cron/reel-check?key=x')).status).toBe(404);
    process.env.CRON_SECRET = 'cron-key-for-test';
    try {
      expect((await api(server.baseUrl, 'GET', '/cron/reel-check?key=wrong')).status).toBe(401);
      expect(run).not.toHaveBeenCalled();
      const res = await api(server.baseUrl, 'GET', '/cron/reel-check?key=cron-key-for-test');
      expect(res.status).toBe(200);
      expect(res.json).toMatchObject({ ok: true, font: 'BeVietnamPro-Bold', render: { width: 1080 } });
      expect(res.json.file).toBeUndefined();
      const video = await fetch(`${server.baseUrl}/cron/reel-check?key=cron-key-for-test&video=1`);
      expect(video.headers.get('content-type')).toBe('video/mp4');
      expect(Buffer.from(await video.arrayBuffer()).toString()).toBe('....ftypvideo');
    } finally {
      delete process.env.CRON_SECRET;
    }
  });
});
