import type { PostStatus } from '@prisma/client';
import prisma from '../utils/prisma';
import { createError } from '../middleware/error.middleware';
import { assertOwnPages } from '../lib/ownership';

/**
 * Approve a written schedule post for its slot ("Duyệt"): used by the web route and by the Telegram button.
 * Throws createError: 404 not the member's post, 400 not a written queued post, 409 no slot left or changed meanwhile.
 */
export async function approveSchedulePost(
  userId: string,
  postId: string
): Promise<{ id: string; status: PostStatus; approvedAt: Date | null; scheduledAt: Date | null }> {
  const post = await prisma.post.findFirst({ where: { id: postId, userId }, include: { targets: true } });
  if (!post) throw createError(404, 'Post not found');
  if (!post.scheduleQueued || post.status !== 'READY') {
    throw createError(400, 'Chỉ duyệt được bài của lịch đăng đã viết xong và đang chờ duyệt.');
  }
  // No slot left (past the schedule's end date): approved, it would wait for ever
  if (!post.scheduledAt) {
    throw createError(409, 'Lịch đã hết khung giờ cho bài này (qua ngày kết thúc). Hãy đăng ngay hoặc hẹn giờ đăng riêng cho bài.');
  }
  // Same Page checks as "Đăng": approving a post that cannot go out would fail silently later
  await assertOwnPages(userId, post.targets.map((t) => t.pageId));
  const { count } = await prisma.post.updateMany({
    where: { id: post.id, status: 'READY', scheduleQueued: true },
    data: { status: 'SCHEDULED', approvedAt: new Date() },
  });
  if (!count) throw createError(409, 'Bài vừa thay đổi, hãy tải lại.');
  await prisma.postLog.create({ data: { postId: post.id, action: 'approved', details: { slot: post.scheduledAt?.toISOString() ?? null } } });
  return prisma.post.findUniqueOrThrow({ where: { id: post.id }, select: { id: true, status: true, approvedAt: true, scheduledAt: true } });
}
