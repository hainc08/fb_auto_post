import type { ContentDomain, ContentFormat, FormatLength, Prisma } from '@prisma/client';
import prisma from '../utils/prisma';
import { createError } from '../middleware/error.middleware';
import { DEFAULT_SYSTEM_PROMPT } from './settings';

/** Content domains: per-user writing profiles, each with several post formats (spec §5). */

export type Db = Prisma.TransactionClient;

export const DOMAIN_LIMIT = 20; // per user, archived included
export const FORMAT_LIMIT = 10; // per domain

const MIGRATED_DOMAIN = 'Mặc định';
const MIGRATED_FORMAT = 'Bài chuẩn';

/** What a member created by the admin starts with (spec §7.4). */
export const STARTER_KIT: {
  domain: { name: string; description: string };
  formats: Array<{ name: string; length: FormatLength; instructions: string }>;
} = {
  domain: { name: 'Chung', description: 'Lĩnh vực mẫu — sửa đối tượng, giọng văn cho đúng Fanpage của bạn' },
  formats: [
    {
      name: 'Mẹo ngắn',
      length: 'SHORT',
      instructions:
        'Mở đầu bằng 1 câu nêu vấn đề quen thuộc với độc giả. Đưa ra đúng 1 mẹo cụ thể, làm được ngay, kèm ví dụ ngắn. Kết bằng 1 câu hỏi mời bình luận.',
    },
    {
      name: 'Listicle 5 ý',
      length: 'MEDIUM',
      instructions:
        'Câu mở đầu hứa hẹn lợi ích rõ ràng. Liệt kê đúng 5 ý, mỗi ý bắt đầu bằng 1️⃣…5️⃣ và một tiêu đề ngắn, sau đó 1–2 câu giải thích. Kết bằng lời mời lưu bài hoặc chia sẻ.',
    },
    {
      name: 'Hỏi đáp',
      length: 'MEDIUM',
      instructions:
        'Mở đầu bằng 1 câu hỏi độc giả hay gặp. Trả lời thẳng trong 1 câu, rồi giải thích 3–4 câu kèm ví dụ cụ thể. Kết bằng lời mời độc giả gửi câu hỏi tiếp theo.',
    },
  ],
};

/** "Mặc định" + legacy "Bài chuẩn" from the user's old system prompt, if the user has no domain yet. */
export async function ensureDefaultDomain(userId: string, db: Db = prisma): Promise<boolean> {
  if ((await db.contentDomain.count({ where: { userId } })) > 0) return false;
  const saved = await db.setting.findUnique({ where: { userId_key: { userId, key: 'systemPrompt' } } });
  await db.contentDomain.create({
    data: {
      userId,
      name: MIGRATED_DOMAIN,
      formats: {
        create: {
          name: MIGRATED_FORMAT,
          instructions: saved?.value?.trim() ? saved.value : DEFAULT_SYSTEM_PROMPT,
          length: 'MEDIUM',
          withImage: true,
          isDefault: true,
          legacyPrompt: true,
        },
      },
    },
  });
  return true;
}

/** Startup migration (idempotent): every user without a domain gets the legacy one. `where` narrows it (tests). */
export async function migrateDomains(db: Db = prisma, where: Prisma.UserWhereInput = {}): Promise<number> {
  const users = await db.user.findMany({ where: { ...where, domains: { none: {} } }, select: { id: true } });
  let migrated = 0;
  for (const { id } of users) if (await ensureDefaultDomain(id, db)) migrated++;
  return migrated;
}

export async function createStarterDomains(userId: string, db: Db = prisma): Promise<void> {
  if ((await db.contentDomain.count({ where: { userId } })) > 0) return;
  await db.contentDomain.create({
    data: {
      userId,
      ...STARTER_KIT.domain,
      formats: { create: STARTER_KIT.formats.map((f, i) => ({ ...f, isDefault: i === 0, sortOrder: i })) },
    },
  });
}

const defaultFormatOf = (domainId: string, db: Db) =>
  db.contentFormat.findFirst({
    where: { domainId, isArchived: false },
    orderBy: [{ isDefault: 'desc' }, { sortOrder: 'asc' }, { createdAt: 'asc' }],
  });

/**
 * Domain + format for a new post / schedule (spec §5.3):
 * explicit format → explicit domain's default format → first Page's default domain →
 * the user's first active domain. Ids must belong to the user (404);
 * a format from another domain is refused (400).
 */
export async function resolveDomainFormat(
  userId: string,
  input: { domainId?: string | null; formatId?: string | null; pageId?: string | null },
  db: Db = prisma
): Promise<{ domain: ContentDomain; format: ContentFormat }> {
  if (input.formatId) {
    const found = await db.contentFormat.findFirst({ where: { id: input.formatId, domain: { userId } }, include: { domain: true } });
    if (!found) throw createError(404, 'Định dạng không tồn tại.');
    if (input.domainId && found.domainId !== input.domainId) throw createError(400, 'Định dạng không thuộc lĩnh vực đã chọn.');
    if (found.isArchived || found.domain.isArchived) throw createError(400, 'Lĩnh vực hoặc định dạng này đã được lưu trữ.');
    const { domain, ...format } = found;
    return { domain, format };
  }

  let domain: ContentDomain | null = null;
  if (input.domainId) {
    domain = await db.contentDomain.findFirst({ where: { id: input.domainId, userId } });
    if (!domain) throw createError(404, 'Lĩnh vực không tồn tại.');
    if (domain.isArchived) throw createError(400, 'Lĩnh vực này đã được lưu trữ.');
  } else {
    if (input.pageId) {
      const page = await db.facebookPage.findFirst({ where: { id: input.pageId, userId }, select: { defaultDomain: true } });
      if (page?.defaultDomain && !page.defaultDomain.isArchived) domain = page.defaultDomain;
    }
    if (!domain) {
      await ensureDefaultDomain(userId, db);
      domain = await db.contentDomain.findFirst({
        where: { userId, isArchived: false },
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      });
    }
    if (!domain) throw createError(400, 'Chưa có lĩnh vực nào đang dùng. Mở mục Lĩnh vực để tạo.');
  }

  const format = await defaultFormatOf(domain.id, db);
  if (!format) throw createError(400, `Lĩnh vực "${domain.name}" chưa có định dạng nào.`);
  return { domain, format };
}

/** The post's own format (even if archived later), else what a new post for its Page would get. */
export async function formatForPost(
  post: { userId: string; pageId: string; formatId: string | null },
  db: Db = prisma
): Promise<{ domain: ContentDomain; format: ContentFormat }> {
  if (post.formatId) {
    const found = await db.contentFormat.findFirst({
      where: { id: post.formatId, domain: { userId: post.userId } },
      include: { domain: true },
    });
    if (found) {
      const { domain, ...format } = found;
      return { domain, format };
    }
  }
  return resolveDomainFormat(post.userId, { pageId: post.pageId }, db);
}
