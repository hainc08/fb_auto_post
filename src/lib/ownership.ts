import prisma from '../utils/prisma';
import { createError } from '../middleware/error.middleware';
import { getSettings } from './settings';
import { blockMessage, blockReason } from './page-health';

/** A template id sent in a request body must belong to the caller (404 otherwise, like ids in the URL). */
export async function assertOwnTemplate(userId: string, templateId: string | null | undefined): Promise<void> {
  if (!templateId) return;
  const template = await prisma.contentTemplate.findFirst({ where: { id: templateId, userId }, select: { id: true } });
  if (!template) throw createError(404, 'Template not found');
}

/**
 * All given Pages must belong to the user and be postable with the current
 * Facebook App (connected, token valid, issued by the App ID in Settings).
 */
export async function assertOwnPages(userId: string, pageIds: string[]) {
  const unique = [...new Set(pageIds)];
  const [pages, settings] = await Promise.all([
    prisma.facebookPage.findMany({ where: { id: { in: unique }, userId } }),
    getSettings(userId),
  ]);
  if (pages.length !== unique.length) throw createError(404, 'Có Page không tồn tại.');

  const blocked = pages.flatMap((page) => {
    const reason = blockReason(page, settings.fbAppId);
    return reason ? [{ page, reason }] : [];
  });
  if (blocked.length) {
    const first = blocked[0];
    throw createError(
      409,
      `Không đăng được lên ${blocked.map((b) => `"${b.page.pageName}"`).join(', ')}: ${blockMessage(first.reason, first.page)} ` +
        'Vào Kênh Facebook → Đồng bộ Page, hoặc bỏ chọn các Page này.'
    );
  }
  return unique;
}
