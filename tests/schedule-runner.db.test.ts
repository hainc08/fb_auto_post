import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { Job } from '@prisma/client';
import '../src/config';
import prisma from '../src/utils/prisma';
import { saveSettings } from '../src/lib/settings';
import { createStarterDomains } from '../src/lib/domains';
import { GeminiClient } from '../src/lib/clients/gemini';
import { CloudflareClient } from '../src/lib/clients/cloudflare';
import { removeImage } from '../src/lib/image-store';
import { reslot, runPrepareJob, runScheduleTick } from '../src/services/schedule-runner';
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

// Friday 2026-09-25 10:00 Vietnam. Slots: every day 08:00 and 19:30
const NOW = new Date('2026-09-25T03:00:00Z');
const FRI_1930 = new Date('2026-09-25T12:30:00Z');
const SAT_0800 = new Date('2026-09-26T01:00:00Z');
const SAT_1930 = new Date('2026-09-26T12:30:00Z');
const SUN_0800 = new Date('2026-09-27T01:00:00Z');

async function makeSchedule(opts: { ideas?: number; bufferSize?: number; isActive?: boolean } = {}) {
  return prisma.postSchedule.create({
    data: {
      userId,
      pageId,
      name: 'Lịch thử',
      frequency: 'SLOTS',
      weekdays: [0, 1, 2, 3, 4, 5, 6],
      slots: ['08:00', '19:30'],
      bufferSize: opts.bufferSize ?? 3,
      isActive: opts.isActive ?? true,
      startDate: new Date('2026-09-01T00:00:00Z'),
      pages: { create: { pageId } },
      ideas: { create: Array.from({ length: opts.ideas ?? 5 }, (_, i) => ({ text: `Ý tưởng ${i + 1}`, position: i })) },
    },
  });
}

async function queuedPost(scheduleId: string, at: Date, status: 'READY' | 'SCHEDULED' | 'FAILED' | 'DRAFT', caption: string | null = 'Bài') {
  return prisma.post.create({
    data: {
      userId,
      pageId,
      scheduleId,
      scheduleQueued: true,
      scheduledAt: at,
      status,
      caption,
      approvedAt: status === 'SCHEDULED' ? new Date() : null,
      targets: { create: { pageId } },
    },
  });
}

const queued = (scheduleId: string) =>
  prisma.post.findMany({ where: { scheduleId, scheduleQueued: true }, orderBy: { scheduledAt: 'asc' }, select: { id: true, scheduledAt: true, status: true } });
const jobsFor = (type: string, postId: string) => prisma.job.count({ where: { type, payload: { path: '$.postId', equals: postId } } });

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

  describe('tick', () => {
    afterAll(async () => {
      const posts = await prisma.post.findMany({ where: { userId }, select: { id: true } });
      await prisma.job.deleteMany({ where: { OR: posts.map((p) => ({ payload: { path: '$.postId', equals: p.id } })) } });
    });

    it('fills the buffer with the next ideas, one post per upcoming slot', async () => {
      const s = await makeSchedule();
      await runScheduleTick(NOW, { id: s.id });
      const posts = await queued(s.id);
      expect(posts.map((p) => p.scheduledAt?.toISOString())).toEqual([FRI_1930, SAT_0800, SAT_1930].map((d) => d.toISOString()));
      expect(posts.every((p) => p.status === 'DRAFT')).toBe(true);
      const ideas = await prisma.scheduleIdea.findMany({ where: { scheduleId: s.id }, orderBy: { position: 'asc' } });
      expect(ideas.map((i) => i.status)).toEqual(['USED', 'USED', 'USED', 'QUEUED', 'QUEUED']);
      for (const p of posts) expect(await jobsFor('prepare_post', p.id)).toBe(1);

      await runScheduleTick(NOW, { id: s.id }); // nothing more to do
      expect(await queued(s.id)).toHaveLength(3);
    });

    it('publishes the approved post whose slot has come', async () => {
      const s = await makeSchedule({ ideas: 0 });
      const due = await queuedPost(s.id, new Date(NOW.getTime() - 60_000), 'SCHEDULED');
      await runScheduleTick(NOW, { id: s.id });
      expect(await prisma.post.findUniqueOrThrow({ where: { id: due.id } })).toMatchObject({ status: 'GENERATING', scheduleQueued: false });
      expect(await jobsFor('publish_post', due.id)).toBe(1);
    });

    it('moves an unapproved post to the next slot and pushes the later ones back', async () => {
      const s = await makeSchedule({ ideas: 0 });
      const late = await queuedPost(s.id, new Date(NOW.getTime() - 60_000), 'READY');
      const next = await queuedPost(s.id, FRI_1930, 'SCHEDULED');
      await runScheduleTick(NOW, { id: s.id });
      const posts = await queued(s.id);
      expect(posts.map((p) => [p.id, p.scheduledAt?.toISOString()])).toEqual([
        [late.id, FRI_1930.toISOString()],
        [next.id, SAT_0800.toISOString()],
      ]);
      expect(await jobsFor('publish_post', next.id)).toBe(0);
    });

    it('after a long sleep, publishes only the earliest approved post and reslots the rest (no burst)', async () => {
      const s = await makeSchedule({ ideas: 0 });
      const a = await queuedPost(s.id, new Date(NOW.getTime() - 3 * 3600_000), 'SCHEDULED');
      const b = await queuedPost(s.id, new Date(NOW.getTime() - 2 * 3600_000), 'SCHEDULED');
      await runScheduleTick(NOW, { id: s.id });
      expect(await jobsFor('publish_post', a.id)).toBe(1);
      expect(await jobsFor('publish_post', b.id)).toBe(0);
      expect((await prisma.post.findUniqueOrThrow({ where: { id: b.id } })).scheduledAt?.toISOString()).toBe(FRI_1930.toISOString());
    });

    it('a post the AI could not write keeps its slot and does not burn more ideas', async () => {
      const s = await makeSchedule({ ideas: 2, bufferSize: 1 });
      await queuedPost(s.id, FRI_1930, 'FAILED', null);
      await runScheduleTick(NOW, { id: s.id });
      await runScheduleTick(new Date(NOW.getTime() + 60_000), { id: s.id });
      expect(await queued(s.id)).toHaveLength(1);
      expect(await prisma.scheduleIdea.count({ where: { scheduleId: s.id, status: 'QUEUED' } })).toBe(2);
    });

    it('with no idea left it creates nothing, and writes again once ideas are added', async () => {
      const s = await makeSchedule({ ideas: 0 });
      await runScheduleTick(NOW, { id: s.id });
      expect(await queued(s.id)).toHaveLength(0);
      await prisma.scheduleIdea.create({ data: { scheduleId: s.id, text: 'Mới', position: 0 } });
      await runScheduleTick(NOW, { id: s.id });
      expect(await queued(s.id)).toHaveLength(1);
    });

    it('a paused schedule, or one whose Pages are all disconnected, does nothing', async () => {
      const paused = await makeSchedule({ isActive: false });
      await runScheduleTick(NOW, { id: paused.id });
      expect(await queued(paused.id)).toHaveLength(0);

      const other = await prisma.facebookPage.create({
        data: { userId, pageId: `SR_OFF_${Date.now()}`, pageName: 'Off', pageAccessToken: 'EAAfaketokenscheduleoffxxxxxxxxxxxx', isActive: false },
      });
      const noPage = await prisma.postSchedule.create({
        data: {
          userId,
          pageId: other.id,
          name: 'Không Page',
          frequency: 'SLOTS',
          weekdays: [5],
          slots: ['19:30'],
          startDate: NOW,
          pages: { create: { pageId: other.id } },
          ideas: { create: { text: 'x', position: 0 } },
        },
      });
      await runScheduleTick(NOW, { id: noPage.id });
      expect(await queued(noPage.id)).toHaveLength(0);
    });

    it("a disabled account's schedule creates no posts", async () => {
      const s = await makeSchedule();
      await prisma.user.update({ where: { id: userId }, data: { isActive: false } });
      try {
        await runScheduleTick(NOW, { id: s.id });
      } finally {
        await prisma.user.update({ where: { id: userId }, data: { isActive: true } });
      }
      expect(await queued(s.id)).toHaveLength(0);
    });

    it("the posts carry the schedule's domain and format", async () => {
      const domain = await prisma.contentDomain.create({
        data: { userId, name: `Lịch ${Date.now()}`, formats: { create: { name: 'F', instructions: 'x', isDefault: true } } },
        include: { formats: true },
      });
      const s = await makeSchedule({ bufferSize: 1 });
      await prisma.postSchedule.update({ where: { id: s.id }, data: { domainId: domain.id, formatId: domain.formats[0].id } });
      await runScheduleTick(NOW, { id: s.id });
      const [post] = await queued(s.id);
      expect(await prisma.post.findUniqueOrThrow({ where: { id: post.id } })).toMatchObject({ domainId: domain.id, formatId: domain.formats[0].id });
    });

    it('reslot puts the queued posts on the next slots in order', async () => {
      const s = await makeSchedule({ ideas: 0 });
      const p1 = await queuedPost(s.id, SAT_1930, 'READY');
      const p2 = await queuedPost(s.id, SUN_0800, 'SCHEDULED');
      await reslot(s.id, NOW);
      expect((await queued(s.id)).map((p) => [p.id, p.scheduledAt?.toISOString()])).toEqual([
        [p1.id, FRI_1930.toISOString()],
        [p2.id, SAT_0800.toISOString()],
      ]);
    });
  });
});
