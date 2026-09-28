import { Router, Response } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import prisma from '../utils/prisma';
import { AuthRequest, authenticate } from '../middleware/auth.middleware';
import { asyncHandler, createError } from '../middleware/error.middleware';
import { DOMAIN_LIMIT, FORMAT_LIMIT } from '../lib/domains';
import { cleanTag } from '../lib/compose-prompt';

/** A user's content domains and their formats (spec §5.4). Formats by id live in formats.routes. */
const router = Router();
router.use(authenticate);

/** Optional text: '' clears it (null); absent stays absent (PATCH keeps the value). */
const text = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .optional()
    .transform((v) => (v === undefined ? undefined : v || null));

export const domainFields = {
  name: z.string().trim().min(1, 'Nhập tên lĩnh vực.').max(80),
  description: text(300),
  audience: text(1000),
  voice: text(1000),
  rules: text(2000),
  defaultHashtags: z
    .array(z.string())
    .max(10, 'Tối đa 10 hashtag mặc định.')
    .transform((tags) => [...new Set(tags.map(cleanTag).filter(Boolean))])
    .optional(),
  imageStyle: text(500),
  sortOrder: z.number().int().min(0).max(1000).optional(),
};

export const formatFields = {
  name: z.string().trim().min(1, 'Nhập tên định dạng.').max(80),
  instructions: z.string().trim().min(1, 'Nhập cấu trúc bài.').max(4000),
  example: text(4000),
  length: z.enum(['SHORT', 'MEDIUM', 'LONG']).optional(),
  withImage: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(1000).optional(),
};

export const isUniqueViolation = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';

const KEEP_ONE = 'Cần giữ ít nhất 1 lĩnh vực đang dùng.';

async function ownedDomain(id: string, userId: string) {
  const domain = await prisma.contentDomain.findFirst({ where: { id, userId } });
  if (!domain) throw createError(404, 'Lĩnh vực không tồn tại.');
  return domain;
}

const activeDomains = (userId: string) => prisma.contentDomain.count({ where: { userId, isArchived: false } });

router.get(
  '/',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const withArchived = req.query.archived === '1';
    const domains = await prisma.contentDomain.findMany({
      where: { userId: req.user!.id, ...(withArchived ? {} : { isArchived: false }) },
      orderBy: [{ isArchived: 'asc' }, { sortOrder: 'asc' }, { createdAt: 'asc' }],
      include: {
        formats: {
          where: withArchived ? {} : { isArchived: false },
          orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
          include: { _count: { select: { posts: true } } },
        },
        _count: { select: { pages: true, posts: true, schedules: true } },
      },
    });
    res.json({ success: true, data: domains });
  })
);

router.post(
  '/',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const userId = req.user!.id;
    const { format, ...domain } = z.object({ ...domainFields, format: z.object(formatFields) }).parse(req.body);
    if ((await prisma.contentDomain.count({ where: { userId } })) >= DOMAIN_LIMIT) {
      throw createError(409, `Tối đa ${DOMAIN_LIMIT} lĩnh vực (tính cả lĩnh vực đã lưu trữ). Hãy xoá bớt lĩnh vực không dùng.`);
    }
    try {
      const created = await prisma.contentDomain.create({
        data: { ...domain, defaultHashtags: domain.defaultHashtags ?? [], userId, formats: { create: { ...format, isDefault: true } } },
        include: { formats: true },
      });
      res.status(201).json({ success: true, data: created });
    } catch (e) {
      if (isUniqueViolation(e)) throw createError(409, 'Bạn đã có lĩnh vực trùng tên này.');
      throw e;
    }
  })
);

router.patch(
  '/:id',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const userId = req.user!.id;
    const change = z.object({ ...domainFields, isArchived: z.boolean() }).partial().parse(req.body);
    const domain = await ownedDomain(req.params.id, userId);
    const archiving = change.isArchived === true && !domain.isArchived;
    if (archiving && (await activeDomains(userId)) <= 1) throw createError(409, KEEP_ONE);

    try {
      const updated = await prisma.$transaction(async (tx) => {
        // An archived domain is no Page's default any more
        if (archiving) await tx.facebookPage.updateMany({ where: { defaultDomainId: domain.id }, data: { defaultDomainId: null } });
        return tx.contentDomain.update({ where: { id: domain.id }, data: change, include: { formats: true } });
      });
      res.json({ success: true, data: updated });
    } catch (e) {
      if (isUniqueViolation(e)) throw createError(409, 'Bạn đã có lĩnh vực trùng tên này.');
      throw e;
    }
  })
);

router.delete(
  '/:id',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const userId = req.user!.id;
    const domain = await prisma.contentDomain.findFirst({
      where: { id: req.params.id, userId },
      include: { _count: { select: { pages: true, posts: true, schedules: true } } },
    });
    if (!domain) throw createError(404, 'Lĩnh vực không tồn tại.');
    const { pages, posts, schedules } = domain._count;
    if (pages + posts + schedules > 0) {
      throw createError(409, `Lĩnh vực đang được dùng (${pages} Page, ${posts} bài, ${schedules} lịch) — hãy lưu trữ thay vì xoá.`);
    }
    if (!domain.isArchived && (await activeDomains(userId)) <= 1) throw createError(409, KEEP_ONE);
    await prisma.contentDomain.delete({ where: { id: domain.id } });
    res.json({ success: true });
  })
);

router.post(
  '/:id/formats',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const body = z.object({ ...formatFields, isDefault: z.boolean().optional() }).parse(req.body);
    const domain = await ownedDomain(req.params.id, req.user!.id);
    if ((await prisma.contentFormat.count({ where: { domainId: domain.id } })) >= FORMAT_LIMIT) {
      throw createError(409, `Mỗi lĩnh vực tối đa ${FORMAT_LIMIT} định dạng.`);
    }
    try {
      const created = await prisma.$transaction(async (tx) => {
        if (body.isDefault) await tx.contentFormat.updateMany({ where: { domainId: domain.id }, data: { isDefault: false } });
        return tx.contentFormat.create({ data: { ...body, domainId: domain.id } });
      });
      res.status(201).json({ success: true, data: created });
    } catch (e) {
      if (isUniqueViolation(e)) throw createError(409, 'Lĩnh vực này đã có định dạng trùng tên.');
      throw e;
    }
  })
);

export default router;
