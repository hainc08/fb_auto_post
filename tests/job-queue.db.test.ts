import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import '../src/config'; // loads .env (DATABASE_URL)
import prisma from '../src/utils/prisma';
import {
  claimNextJob,
  enqueue,
  recoverStaleJobs,
  removeKeyedJob,
  startJobWorker,
  UnrecoverableJobError,
  upsertKeyedJob,
  JobType,
} from '../src/lib/job-queue';

/**
 * Runs against the real MariaDB from .env (the SQL is MariaDB-specific).
 *   RUN_DB_TESTS=1 npx vitest run tests/job-queue.db.test.ts
 * Uses fake job types only, so nothing calls Gemini or Facebook.
 */
const T = 'test_queue' as JobType;
const T2 = 'test_queue_other' as JobType;

const cleanup = () => prisma.job.deleteMany({ where: { type: { in: [T, T2] } } });
const waitFor = async (check: () => Promise<boolean>, ms = 8000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('timed out');
};

describe.skipIf(!process.env.RUN_DB_TESTS)('MariaDB job queue', () => {
  beforeEach(cleanup);
  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  it('never hands the same job to two concurrent claimers', async () => {
    for (let i = 0; i < 5; i++) await enqueue(T, { i });
    const claims = await Promise.all(Array.from({ length: 12 }, () => claimNextJob([T])));
    const got = claims.filter(Boolean).map((j) => j!.id);
    expect(got).toHaveLength(5);
    expect(new Set(got).size).toBe(5);
    expect(claims.filter(Boolean).every((j) => j!.status === 'RUNNING' && j!.attempts === 1)).toBe(true);
  });

  it('does not claim future jobs or other types (UTC comparison)', async () => {
    await enqueue(T, {}, { runAt: new Date(Date.now() + 60_000) });
    await enqueue(T2, {});
    expect(await claimNextJob([T])).toBeNull();
  });

  it('retries with backoff, then succeeds', async () => {
    const job = await enqueue(T, { n: 1 });
    let calls = 0;
    const stop = startJobWorker({ [T]: async () => { if (++calls === 1) throw new Error('flaky'); } } as never, { pollMs: 100 });
    try {
      await waitFor(async () => (await prisma.job.findUnique({ where: { id: job.id } }))!.lastError === 'flaky');
      const retrying = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
      expect(retrying.status).toBe('PENDING');
      expect(retrying.runAt.getTime()).toBeGreaterThan(Date.now());
      // skip the backoff wait
      await prisma.job.update({ where: { id: job.id }, data: { runAt: new Date(Date.now() - 1000) } });
      await waitFor(async () => (await prisma.job.findUnique({ where: { id: job.id } }))!.status === 'DONE');
      expect(calls).toBe(2);
    } finally {
      stop();
    }
  });

  it('fails immediately on UnrecoverableJobError', async () => {
    const job = await enqueue(T, {});
    const stop = startJobWorker({ [T]: async () => { throw new UnrecoverableJobError('no'); } } as never, { pollMs: 100 });
    try {
      await waitFor(async () => (await prisma.job.findUnique({ where: { id: job.id } }))!.status === 'FAILED');
      const failed = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
      expect(failed.attempts).toBe(1);
      expect(failed.lastError).toBe('no');
    } finally {
      stop();
    }
  });

  it('keyed jobs are unique, movable and reschedulable', async () => {
    const key = 'schedule:test-queue';
    await upsertKeyedJob(key, T, { s: 1 }, new Date(Date.now() - 1000));
    await upsertKeyedJob(key, T, { s: 1 }, new Date(Date.now() - 500));
    expect(await prisma.job.count({ where: { key } })).toBe(1);

    const next = new Date(Date.now() + 3_600_000);
    const stop = startJobWorker({ [T]: async () => ({ rescheduleAt: next }) } as never, { pollMs: 100 });
    try {
      await waitFor(async () => (await prisma.job.findUnique({ where: { key } }))!.runAt.getTime() === next.getTime());
      const job = await prisma.job.findUniqueOrThrow({ where: { key } });
      expect(job).toMatchObject({ status: 'PENDING', attempts: 0 });
    } finally {
      stop();
    }
    await removeKeyedJob(key);
    expect(await prisma.job.count({ where: { key } })).toBe(0);
  });

  it('puts jobs of a dead process back as interrupted', async () => {
    const job = await enqueue(T, {});
    await claimNextJob([T]);
    await prisma.job.update({ where: { id: job.id }, data: { lockedAt: new Date(Date.now() - 11 * 60_000) } });
    expect(await recoverStaleJobs()).toBeGreaterThanOrEqual(1);
    const recovered = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(recovered).toMatchObject({ status: 'PENDING', interrupted: true, lockToken: null });
  });
});

describe.skipIf(!process.env.RUN_DB_TESTS)('drain (cron tick)', () => {
  afterAll(cleanup);

  it('runs every due job now and waits for them, even with a slow poll interval', async () => {
    await cleanup();
    const jobs = await Promise.all([1, 2, 3].map((i) => enqueue(T, { i })));
    const worker = startJobWorker({ [T]: async () => { await new Promise((r) => setTimeout(r, 100)); } } as never, { pollMs: 3_600_000, concurrency: 2 });
    try {
      // The start-up poll may already take some; drain finishes the rest and waits
      await worker.drain(10_000);
      const statuses = await prisma.job.findMany({ where: { id: { in: jobs.map((j) => j.id) } }, select: { status: true } });
      expect(statuses.every((s) => s.status === 'DONE')).toBe(true);
    } finally {
      worker();
    }
  });
});
