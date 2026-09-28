import prisma from '../utils/prisma';
import { createError } from '../middleware/error.middleware';

/** A template id sent in a request body must belong to the caller (404 otherwise, like ids in the URL). */
export async function assertOwnTemplate(userId: string, templateId: string | null | undefined): Promise<void> {
  if (!templateId) return;
  const template = await prisma.contentTemplate.findFirst({ where: { id: templateId, userId }, select: { id: true } });
  if (!template) throw createError(404, 'Template not found');
}
