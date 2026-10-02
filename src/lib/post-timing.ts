import type { PostStatus } from '@prisma/client';
import prisma from '../utils/prisma';

/** Timed posts ("Hẹn giờ đăng"): one post published at a time the user picks, outside any slot schedule. */

/** The browser asks for 1 minute ahead; this leaves room for clock skew and request latency */
export const MIN_LEAD_MS = 30_000;
export const MAX_AHEAD_DAYS = 90;

/** Why this time cannot be used (shown to the user); null = fine */
export function timedProblem(at: Date, now = new Date()): string | null {
  if (Number.isNaN(at.getTime())) return 'Giờ đăng không hợp lệ.';
  if (at.getTime() < now.getTime() + MIN_LEAD_MS) return 'Giờ đăng phải sau hiện tại ít nhất 1 phút.';
  if (at.getTime() > now.getTime() + MAX_AHEAD_DAYS * 86_400_000) return `Chỉ hẹn được trong ${MAX_AHEAD_DAYS} ngày tới.`;
  return null;
}

/**
 * Take the post for publishing, only if it still waits for exactly this time.
 * False = the user moved the time, cancelled, published by hand or deleted the post.
 */
export async function claimTimedPost(postId: string, scheduledFor: Date): Promise<boolean> {
  const { count } = await prisma.post.updateMany({
    where: { id: postId, status: 'SCHEDULED', scheduleQueued: false, scheduledAt: scheduledFor },
    data: { status: 'GENERATING' },
  });
  return count === 1;
}

/** May this timed job publish the post? `attempt` is 1 on the first run. */
export async function timedJobMayRun(post: { id: string; status: PostStatus }, scheduledFor: Date, attempt: number): Promise<boolean> {
  // A retry of a run that already took the post (PUBLISHING: it stopped while queueing the Pages).
  // Skipping it would leave the post in progress for ever; a Page is never published twice (runTargetJob's own claim).
  if (attempt > 1 && (post.status === 'GENERATING' || post.status === 'PUBLISHING')) return true;
  return claimTimedPost(post.id, scheduledFor);
}
