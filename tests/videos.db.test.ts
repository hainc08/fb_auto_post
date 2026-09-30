import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import '../src/config';
import prisma from '../src/utils/prisma';
import { createApp } from '../src/app';
import { resolveVideo, VIDEO_TMP_DIR } from '../src/lib/video-store';
import { readImage } from '../src/lib/image-store';
import { startTestServer, api } from './helpers/http';
import { cleanupTestUsers, createTestUser } from './helpers/users';
import { tinyMp4 } from './helpers/mp4';

let server: Awaited<ReturnType<typeof startTestServer>>;
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('img')]);

async function upload(cookie: string, postId: string, kind: 'video' | 'image', content: Buffer, name: string) {
  const form = new FormData();
  form.append(kind, new Blob([content]), name);
  const res = await fetch(`${server.baseUrl}/api/posts/${postId}/${kind}/upload`, {
    method: 'POST',
    headers: { Cookie: cookie, 'X-Requested-With': 'autopost' },
    body: form,
  });
  return { status: res.status, json: await res.json() };
}

async function draft(userId: string) {
  const page = await prisma.facebookPage.create({
    data: { userId, pageId: `VID_${Date.now()}_${Math.random()}`, pageName: 'P', pageAccessToken: 'EAAfaketokenvideosxxxxxxxxxxxxxxxx' },
  });
  return prisma.post.create({ data: { userId, pageId: page.id, caption: 'x' } });
}

const tmpLeftovers = async () => (existsSync(VIDEO_TMP_DIR) ? (await readdir(VIDEO_TMP_DIR)).length : 0);

describe.skipIf(!process.env.RUN_DB_TESTS)('post videos', { timeout: 60_000 }, () => {
  beforeAll(async () => {
    await cleanupTestUsers();
    server = await startTestServer(createApp());
  });
  afterAll(async () => {
    await server.close();
    await cleanupTestUsers();
    await prisma.$disconnect();
  });

  it('uploads a video, reports Reels eligibility, serves it with Range, and replaces the image', async () => {
    const { user, cookie } = await createTestUser();
    const post = await draft(user.id);
    const img = await upload(cookie, post.id, 'image', PNG, 'a.png');
    expect(img.status).toBe(200);
    const imagePath = (await prisma.post.findUniqueOrThrow({ where: { id: post.id } })).imagePath;

    const res = await upload(cookie, post.id, 'video', tinyMp4({ durationSec: 30, width: 1920, height: 1080 }), 'clip.mp4');
    expect(res.status).toBe(200);
    expect(res.json.data).toMatchObject({ videoKind: 'FEED', videoMeta: { durationSec: 30, width: 1920, height: 1080 } });
    expect(res.json.data.reelsProblem).toMatch(/video dọc/);

    const saved = await prisma.post.findUniqueOrThrow({ where: { id: post.id } });
    expect(saved).toMatchObject({ imagePath: null, imageUrl: null, videoMime: 'video/mp4' });
    expect(await readImage(imagePath!)).toBeNull(); // the image file was deleted

    const ranged = await fetch(`${server.baseUrl}${res.json.data.videoUrl}`, { headers: { Cookie: cookie, Range: 'bytes=0-15' } });
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get('content-type')).toBe('video/mp4');
    expect((await ranged.arrayBuffer()).byteLength).toBe(16);

    // Reels refused for a landscape video, allowed for a vertical one
    const bad = await api(server.baseUrl, 'PATCH', `/api/posts/${post.id}`, { cookie, body: { videoKind: 'REEL' } });
    expect(bad.status).toBe(400);
    expect(bad.json.error).toMatch(/video dọc/);
    await upload(cookie, post.id, 'video', tinyMp4({ durationSec: 20, width: 1080, height: 1920 }), 'reel.mp4');
    const reel = await api(server.baseUrl, 'PATCH', `/api/posts/${post.id}`, { cookie, body: { videoKind: 'REEL' } });
    expect(reel.json.data.videoKind).toBe('REEL');
    expect(existsSync(resolveVideo(saved.videoPath!)!)).toBe(false); // the first video file is gone
    await api(server.baseUrl, 'DELETE', `/api/posts/${post.id}`, { cookie }); // test users are deleted without their files
  });

  it('rejects a file that is not a video and leaves no temp file', async () => {
    const { user, cookie } = await createTestUser();
    const post = await draft(user.id);
    const before = await tmpLeftovers();
    const res = await upload(cookie, post.id, 'video', PNG, 'fake.mp4');
    expect(res.status).toBe(400);
    expect(res.json.error).toMatch(/Video không hợp lệ/);
    expect(await tmpLeftovers()).toBe(before);
    expect((await prisma.post.findUniqueOrThrow({ where: { id: post.id } })).videoPath).toBeNull();

    // A wrong form field is a client error, not a 500
    const form = new FormData();
    form.append('file', new Blob([tinyMp4({ durationSec: 5, width: 640, height: 360 })]), 'v.mp4');
    const wrong = await fetch(`${server.baseUrl}/api/posts/${post.id}/video/upload`, {
      method: 'POST',
      headers: { Cookie: cookie, 'X-Requested-With': 'autopost' },
      body: form,
    });
    expect(wrong.status).toBe(400);
    expect(await tmpLeftovers()).toBe(before);
  });

  it('an image upload replaces the video; removing and deleting clean up the file', async () => {
    const { user, cookie } = await createTestUser();
    const post = await draft(user.id);
    await upload(cookie, post.id, 'video', tinyMp4({ durationSec: 10, width: 640, height: 360 }), 'v.mp4');
    const first = (await prisma.post.findUniqueOrThrow({ where: { id: post.id } })).videoPath!;
    await upload(cookie, post.id, 'image', PNG, 'a.png');
    expect(await prisma.post.findUniqueOrThrow({ where: { id: post.id } })).toMatchObject({ videoPath: null, videoKind: null });
    expect(existsSync(resolveVideo(first)!)).toBe(false);

    await upload(cookie, post.id, 'video', tinyMp4({ durationSec: 10, width: 640, height: 360 }), 'v.mp4');
    const second = (await prisma.post.findUniqueOrThrow({ where: { id: post.id } })).videoPath!;
    expect((await api(server.baseUrl, 'DELETE', `/api/posts/${post.id}/video`, { cookie })).status).toBe(200);
    expect(existsSync(resolveVideo(second)!)).toBe(false);

    await upload(cookie, post.id, 'video', tinyMp4({ durationSec: 10, width: 640, height: 360 }), 'v.mp4');
    const third = (await prisma.post.findUniqueOrThrow({ where: { id: post.id } })).videoPath!;
    expect((await api(server.baseUrl, 'DELETE', `/api/posts/${post.id}`, { cookie })).status).toBe(200);
    expect(existsSync(resolveVideo(third)!)).toBe(false);
  });

  it("deleting a member removes that member's video files", async () => {
    const admin = await createTestUser({ role: 'ADMIN' });
    const member = await createTestUser();
    const post = await draft(member.user.id);
    await upload(member.cookie, post.id, 'video', tinyMp4({ durationSec: 10, width: 640, height: 360 }), 'v.mp4');
    const file = resolveVideo((await prisma.post.findUniqueOrThrow({ where: { id: post.id } })).videoPath!)!;
    const del = await api(server.baseUrl, 'DELETE', `/api/admin/users/${member.user.id}`, {
      cookie: admin.cookie,
      body: { confirmEmail: member.user.email },
    });
    expect(del.status).toBe(200);
    expect(existsSync(file)).toBe(false);
  });
});
