import { randomUUID } from 'node:crypto';
import { Job, Prisma } from '@prisma/client';
import prisma from '../utils/prisma';
import { logger } from '../utils/logger';

/**
 * Background job queue stored in MariaDB (table `jobs`), replacing BullMQ + Redis.
 *
 * - Claiming is one atomic `UPDATE … ORDER BY runAt LIMIT 1` with a random lock
 *   token, so a job never runs twice at the same time, even with several processes.
 * - Retryable failures come back later with exponential backoff; the job fails for
 *   good after `maxAttempts` or on `UnrecoverableJobError`.
 * - A job left RUNNING by a crashed process is put back to PENDING with
 *   `interrupted = true`, so its handler can decide whether a retry is safe.
 */

export type JobType = 'publish_post' | 'run_schedule';

/** Throw from a handler to fail the job now, without retrying. */
export class UnrecoverableJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnrecoverableJobError';
  }
}

/** Returned by a handler to run the same job again later (recurring schedules). */
export interface JobResult {
  rescheduleAt?: Date;
}

export type JobHandler = (job: Job) => Promise<JobResult | void>;

const RETRY_BASE_MS = 5_000; // 5s, 10s, 20s…
const STALE_AFTER_MS = 10 * 60_000; // a single job never legitimately runs this long
const KEEP_DONE_DAYS = 7;
const KEEP_FAILED_DAYS = 30;

export interface EnqueueOptions {
  runAt?: Date;
  maxAttempts?: number;
}

export async function enqueue(type: JobType, payload: Prisma.InputJsonObject, options: EnqueueOptions = {}): Promise<Job> {
  return prisma.job.create({
    data: { type, payload, runAt: options.runAt ?? new Date(), maxAttempts: options.maxAttempts ?? 3 },
  });
}

/** Create or move the single job identified by `key` (e.g. one per schedule). */
export async function upsertKeyedJob(key: string, type: JobType, payload: Prisma.InputJsonObject, runAt: Date): Promise<void> {
  const reset = { type, payload, runAt, status: 'PENDING' as const, attempts: 0, lastError: null, interrupted: false, finishedAt: null };
  await prisma.job.upsert({
    where: { key },
    create: { key, ...reset, maxAttempts: 1 },
    update: reset,
  });
}

export async function removeKeyedJob(key: string): Promise<void> {
  await prisma.job.deleteMany({ where: { key } });
}

export function retryDelayMs(attempts: number): number {
  return RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1);
}

/** Atomically take the oldest due job. `attempts` is already incremented. */
export async function claimNextJob(types: string[]): Promise<Job | null> {
  if (types.length === 0) return null;
  const token = randomUUID();
  const claimed = await prisma.$executeRaw`
    UPDATE jobs
    SET status = 'RUNNING', lockToken = ${token}, lockedAt = UTC_TIMESTAMP(3),
        attempts = attempts + 1, updatedAt = UTC_TIMESTAMP(3)
    WHERE status = 'PENDING' AND runAt <= UTC_TIMESTAMP(3) AND type IN (${Prisma.join(types)})
    ORDER BY runAt
    LIMIT 1`;
  if (claimed === 0) return null;
  return prisma.job.findFirst({ where: { lockToken: token } });
}

async function finishJob(job: Job, result: JobResult | void): Promise<void> {
  if (result?.rescheduleAt) {
    await prisma.job.update({
      where: { id: job.id },
      data: { status: 'PENDING', runAt: result.rescheduleAt, attempts: 0, lockToken: null, lockedAt: null, interrupted: false, lastError: null },
    });
  } else {
    await prisma.job.update({
      where: { id: job.id },
      data: { status: 'DONE', finishedAt: new Date(), lockToken: null, lockedAt: null },
    });
  }
}

async function failJob(job: Job, error: unknown): Promise<void> {
  const message = (error as Error)?.message ?? String(error);
  const final = error instanceof UnrecoverableJobError || job.attempts >= job.maxAttempts;
  await prisma.job.update({
    where: { id: job.id },
    data: final
      ? { status: 'FAILED', finishedAt: new Date(), lastError: message, lockToken: null, lockedAt: null }
      : {
          status: 'PENDING',
          runAt: new Date(Date.now() + retryDelayMs(job.attempts)),
          lastError: message,
          lockToken: null,
          lockedAt: null,
        },
  });
  logger.error(`[Jobs] ${job.type} ${job.id} ${final ? 'failed' : 'will retry'}`, { attempt: job.attempts, error: message });
}

/** Put jobs abandoned by a dead process back in the queue, flagged as interrupted. */
export async function recoverStaleJobs(now = new Date()): Promise<number> {
  const { count } = await prisma.job.updateMany({
    where: { status: 'RUNNING', lockedAt: { lt: new Date(now.getTime() - STALE_AFTER_MS) } },
    data: { status: 'PENDING', interrupted: true, lockToken: null, lockedAt: null, runAt: now },
  });
  if (count) logger.warn(`[Jobs] Recovered ${count} interrupted job(s)`);
  return count;
}

async function pruneOldJobs(now = new Date()): Promise<void> {
  const day = 24 * 60 * 60_000;
  await prisma.job.deleteMany({
    where: {
      key: null,
      OR: [
        { status: 'DONE', finishedAt: { lt: new Date(now.getTime() - KEEP_DONE_DAYS * day) } },
        { status: 'FAILED', finishedAt: { lt: new Date(now.getTime() - KEEP_FAILED_DAYS * day) } },
      ],
    },
  });
}

export interface WorkerOptions {
  pollMs?: number;
  concurrency?: number;
}

/**
 * Poll the queue and run due jobs in this process. Returns a stop function.
 */
export function startJobWorker(handlers: Partial<Record<JobType, JobHandler>>, options: WorkerOptions = {}): () => void {
  const { pollMs = 3_000, concurrency = 2 } = options;
  const types = Object.keys(handlers);
  let running = 0;
  let polling = false;
  let stopped = false;

  async function run(job: Job) {
    running++;
    try {
      const result = await handlers[job.type as JobType]!(job);
      await finishJob(job, result);
    } catch (error) {
      await failJob(job, error).catch((e) => logger.error('[Jobs] Could not record failure', { jobId: job.id, error: (e as Error).message }));
    } finally {
      running--;
    }
  }

  async function poll() {
    if (polling || stopped) return;
    polling = true;
    try {
      while (running < concurrency && !stopped) {
        const job = await claimNextJob(types);
        if (!job) break;
        void run(job);
      }
    } catch (error) {
      logger.error('[Jobs] Poll failed', { error: (error as Error).message });
    } finally {
      polling = false;
    }
  }

  async function maintain() {
    try {
      await recoverStaleJobs();
      await pruneOldJobs();
    } catch (error) {
      logger.error('[Jobs] Maintenance failed', { error: (error as Error).message });
    }
  }

  void maintain().then(poll);
  const pollTimer = setInterval(poll, pollMs);
  const maintainTimer = setInterval(maintain, 60_000);
  logger.info('[Jobs] Worker started', { types, pollMs, concurrency });

  return () => {
    stopped = true;
    clearInterval(pollTimer);
    clearInterval(maintainTimer);
  };
}
