import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Job } from '@prisma/client';
import '../src/config';
import prisma from '../src/utils/prisma';
import { claimTimedPost, timedJobMayRun } from '../src/lib/post-timing';
import { enqueuePost, runPublishJob } from '../src/services/scheduler.service';
import { cleanupTestUsers, createTestUser } from './helpers/users';

let userId: string;
let pageId: string;
const AT = new Date('2031-05-06T02:00:00.000Z');
const OTHER = new Date('2031-05-07T02:00:00.000Z');

const timed = (data: { status?: 'SCHEDULED' | 'READY' | 'GENERATING'; scheduleQueued?: boolean } = {}) =>
  prisma.post.create({
    data: { userId, pageId, caption: 'Bài hẹn giờ', status: data.status ?? 'SCHEDULED', scheduleQueued: data.scheduleQueued ?? false, scheduledAt: AT, targets: { create: { pageId } } },
  });
const statusOf = async (id: string) => (await prisma.post.findUniqueOrThrow({ where: { id } })).status;
const jobsOf = (postId: string, type: string) => prisma.job.findMany({ where: { type, payload: { path: '$.postId', equals: postId } } });

describe.skipIf(!process.env.RUN_DB_TESTS)('timed posts: the claim', { timeout: 60_000 }, () => {
  beforeAll(async () => {
    userId = (await createTestUser()).user.id;
    pageId = (await prisma.facebookPage.create({ data: { userId, pageId: `TMD_${Date.now()}`, pageName: 'P', pageAccessToken: 'EAAfaketokentimedxxxxxxxxxxxxxxxxxx', tokenStatus: 'VALID' } })).id;
  });
  afterAll(async () => {
    const posts = await prisma.post.findMany({ where: { userId }, select: { id: true } });
    if (posts.length) await prisma.job.deleteMany({ where: { OR: posts.map((p) => ({ payload: { path: '$.postId', equals: p.id } })) } });
    await cleanupTestUsers();
    await prisma.$disconnect();
  });

  it('only one job takes the post', async () => {
    const post = await timed();
    expect(await claimTimedPost(post.id, AT)).toBe(true);
    expect(await statusOf(post.id)).toBe('GENERATING');
    expect(await claimTimedPost(post.id, AT)).toBe(false);
  });

  it('a job booked for another time does not take it', async () => {
    const post = await timed();
    expect(await claimTimedPost(post.id, OTHER)).toBe(false);
    expect(await statusOf(post.id)).toBe('SCHEDULED');
  });

  it('never takes a cancelled post or a post of a slot schedule', async () => {
    expect(await claimTimedPost((await timed({ status: 'READY' })).id, AT)).toBe(false);
    expect(await claimTimedPost((await timed({ scheduleQueued: true })).id, AT)).toBe(false);
  });

  it('a retry of a run that already took the post goes on', async () => {
    const post = await timed({ status: 'GENERATING' });
    expect(await timedJobMayRun(post, AT, 2)).toBe(true);
    // the first attempt never skips the claim
    expect(await timedJobMayRun(post, AT, 1)).toBe(false);
  });

  it('enqueuePost books the job at the chosen time and records it', async () => {
    const post = await timed();
    await enqueuePost(post.id, userId, { scheduledFor: AT, intervalMs: 120_000 });
    const [job] = await jobsOf(post.id, 'publish_post');
    expect(job.runAt.toISOString()).toBe(AT.toISOString());
    expect(job.payload).toMatchObject({ postId: post.id, userId, scheduledFor: AT.toISOString(), intervalMs: 120_000 });
  });

  it('an out-of-date timed job does nothing', async () => {
    const post = await timed();
    const stale = { id: 'stale-job', attempts: 1, maxAttempts: 3, payload: { postId: post.id, userId, scheduledFor: OTHER.toISOString() } } as unknown as Job;
    await runPublishJob(stale);
    expect(await statusOf(post.id)).toBe('SCHEDULED');
    expect(await prisma.postLog.count({ where: { postId: post.id } })).toBe(0);
    expect(await jobsOf(post.id, 'publish_target')).toHaveLength(0);
  });
});
