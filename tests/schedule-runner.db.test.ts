import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { Job } from '@prisma/client';
import '../src/config';
import prisma from '../src/utils/prisma';
import { saveSettings } from '../src/lib/settings';
import { createStarterDomains } from '../src/lib/domains';
import { GeminiClient } from '../src/lib/clients/gemini';
import { CloudflareClient } from '../src/lib/clients/cloudflare';
import { removeImage } from '../src/lib/image-store';
import { runPrepareJob } from '../src/services/schedule-runner';
import { cleanupTestUsers, createTestUser } from './helpers/users';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('img')]);
const fakeJob = (postId: string, attempts = 1): Job => ({ payload: { postId }, attempts, maxAttempts: 3 }) as unknown as Job;

let userId: string;
let pageId: string;

async function draftPost() {
  return prisma.post.create({
    data: {
      userId,
      pageId,
      status: 'DRAFT',
      scheduleQueued: true,
      scheduledAt: new Date(Date.now() + 3600_000),
      inputData: { basicInfo: 'Mẹo tưới lúa mùa khô' },
      targets: { create: { pageId } },
    },
  });
}

describe.skipIf(!process.env.RUN_DB_TESTS)('schedule runner', { timeout: 60_000 }, () => {
  beforeAll(async () => {
    const { user } = await createTestUser();
    userId = user.id;
    await saveSettings(userId, { geminiApiKey: 'AIzaFakeKeyScheduleRunner0000000000000', cfAccountId: 'fakeaccount', cfApiToken: 'fake-cf-token-schedule' });
    await createStarterDomains(userId);
    pageId = (
      await prisma.facebookPage.create({
        data: { userId, pageId: `SR_${Date.now()}`, pageName: 'Nhà nông', pageAccessToken: 'EAAfaketokenschedulerunnerxxxxxxxxx', tokenStatus: 'VALID' },
      })
    ).id;
  });
  afterAll(async () => {
    const posts = await prisma.post.findMany({ where: { userId }, select: { imagePath: true } });
    await Promise.all(posts.map((p) => removeImage(p.imagePath)));
    await cleanupTestUsers();
    await prisma.$disconnect();
  });

  describe('prepare_post', () => {
    it('writes the text, makes the image, and leaves the post waiting for approval', async () => {
      const post = await draftPost();
      vi.spyOn(GeminiClient.prototype, 'generateJson').mockResolvedValue({ post: 'Bài về tưới lúa', image_prompt: 'rice field' } as never);
      vi.spyOn(CloudflareClient.prototype, 'generateImage').mockResolvedValue({ buffer: PNG, mimeType: 'image/png' } as never);
      await runPrepareJob(fakeJob(post.id));
      const saved = await prisma.post.findUniqueOrThrow({ where: { id: post.id } });
      expect(saved).toMatchObject({ status: 'READY', caption: 'Bài về tưới lúa', imagePrompt: 'rice field' });
      expect(saved.imagePath).not.toBeNull();
    });

    it('never overwrites a post the user already wrote', async () => {
      const post = await draftPost();
      await prisma.post.update({ where: { id: post.id }, data: { caption: 'Tự viết', status: 'READY' } });
      const gemini = vi.spyOn(GeminiClient.prototype, 'generateJson');
      await runPrepareJob(fakeJob(post.id));
      expect(gemini).not.toHaveBeenCalled();
      expect((await prisma.post.findUniqueOrThrow({ where: { id: post.id } })).caption).toBe('Tự viết');
    });

    it('an image failure keeps the text and still asks for approval', async () => {
      const post = await draftPost();
      vi.spyOn(GeminiClient.prototype, 'generateJson').mockResolvedValue({ post: 'Có chữ', image_prompt: 'x' } as never);
      vi.spyOn(CloudflareClient.prototype, 'generateImage').mockRejectedValue(new Error('quota'));
      await runPrepareJob(fakeJob(post.id));
      expect(await prisma.post.findUniqueOrThrow({ where: { id: post.id } })).toMatchObject({ status: 'READY', caption: 'Có chữ', imagePath: null });
    });

    it('on the last attempt a text failure marks the post FAILED with the reason, and it keeps its slot', async () => {
      const post = await draftPost();
      vi.spyOn(GeminiClient.prototype, 'generateJson').mockRejectedValue(new Error('API key not valid'));
      await expect(runPrepareJob(fakeJob(post.id, 3))).rejects.toThrow();
      const saved = await prisma.post.findUniqueOrThrow({ where: { id: post.id } });
      expect(saved.status).toBe('FAILED');
      expect(saved.errorMessage).toMatch(/AI chưa viết được bài/);
      expect(saved.scheduleQueued).toBe(true);
    });

    it('before the last attempt a failure puts the post back to DRAFT for the retry', async () => {
      const post = await draftPost();
      vi.spyOn(GeminiClient.prototype, 'generateJson').mockRejectedValue(new Error('503 overloaded'));
      await expect(runPrepareJob(fakeJob(post.id, 1))).rejects.toThrow();
      expect((await prisma.post.findUniqueOrThrow({ where: { id: post.id } })).status).toBe('DRAFT');
    });
  });
});
