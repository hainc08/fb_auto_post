import { Router, Response } from 'express';
import { z } from 'zod';
import prisma from '../utils/prisma';
import { AuthRequest, authenticate, requireAdmin } from '../middleware/auth.middleware';
import { asyncHandler, createError } from '../middleware/error.middleware';
import { hashPassword, normalizeEmail, passwordSchema } from '../lib/passwords';
import { accountChangeBlock } from '../lib/admin-guards';
import { removeImage } from '../lib/image-store';
import { createStarterDomains } from '../lib/domains';
import { logger } from '../utils/logger';

/** Member management. Admins never read other users' content here — only counts. */
const router = Router();
router.use(authenticate, requireAdmin);

const DAY = 24 * 60 * 60 * 1000;
const memberSelect = { id: true, email: true, name: true, role: true, isActive: true, lastLoginAt: true, createdAt: true } as const;
const emailField = z.string().transform(normalizeEmail).pipe(z.string().email('Email không hợp lệ.'));
const roleField = z.enum(['ADMIN', 'USER']);

const otherActiveAdmins = (targetId: string) =>
  prisma.user.count({ where: { role: 'ADMIN', isActive: true, NOT: { id: targetId } } });

router.get(
  '/users',
  asyncHandler(async (_req: AuthRequest, res: Response) => {
    const [users, posts] = await Promise.all([
      prisma.user.findMany({
        orderBy: { createdAt: 'asc' },
        select: { ...memberSelect, _count: { select: { pages: { where: { isActive: true } } } } },
      }),
      prisma.post.groupBy({ by: ['userId'], where: { createdAt: { gte: new Date(Date.now() - 30 * DAY) } }, _count: { _all: true } }),
    ]);
    const posts30d = new Map(posts.map((p) => [p.userId, p._count._all]));
    res.json({
      success: true,
      data: users.map(({ _count, ...u }) => ({ ...u, pages: _count.pages, posts30d: posts30d.get(u.id) ?? 0 })),
    });
  })
);

router.post(
  '/users',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const body = z
      .object({
        email: emailField,
        name: z.string().trim().min(1, 'Nhập tên.').max(100),
        password: passwordSchema,
        role: roleField.default('USER'),
      })
      .parse(req.body);
    if (await prisma.user.findUnique({ where: { email: body.email } })) throw createError(409, 'Email này đã có tài khoản.');

    const user = await prisma.user.create({
      data: { email: body.email, name: body.name, role: body.role, plan: 'ENTERPRISE', passwordHash: await hashPassword(body.password) },
      select: memberSelect,
    });
    await createStarterDomains(user.id);
    logger.info('Member created', { adminId: req.user!.id, userId: user.id });
    res.status(201).json({ success: true, data: user });
  })
);

router.patch(
  '/users/:id',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const change = z
      .object({
        name: z.string().trim().min(1).max(100).optional(),
        email: emailField.optional(),
        password: passwordSchema.optional(),
        role: roleField.optional(),
        isActive: z.boolean().optional(),
      })
      .parse(req.body);

    const target = await prisma.user.findUnique({ where: { id: req.params.id } });
    if (!target) throw createError(404, 'Không tìm thấy người dùng.');

    const blocked = accountChangeBlock({ actorId: req.user!.id, target, change, otherActiveAdmins: await otherActiveAdmins(target.id) });
    if (blocked) throw createError(409, blocked);

    const emailChanged = change.email !== undefined && change.email !== target.email;
    if (emailChanged && (await prisma.user.findUnique({ where: { email: change.email! } }))) {
      throw createError(409, 'Email này đã có tài khoản.');
    }

    // New credentials, a new role or disabling ⇒ the member must log in again
    const endsSessions =
      change.password !== undefined ||
      emailChanged ||
      (change.role !== undefined && change.role !== target.role) ||
      change.isActive === false;

    const updated = await prisma.user.update({
      where: { id: target.id },
      data: {
        ...(change.name !== undefined && { name: change.name }),
        ...(emailChanged && { email: change.email }),
        ...(change.role !== undefined && { role: change.role }),
        ...(change.isActive !== undefined && { isActive: change.isActive }),
        ...(change.password !== undefined && { passwordHash: await hashPassword(change.password) }),
        ...(endsSessions && { tokenVersion: { increment: 1 } }),
      },
      select: memberSelect,
    });
    logger.info('Member updated', { adminId: req.user!.id, userId: target.id, fields: Object.keys(change) });
    res.json({ success: true, data: updated });
  })
);

router.delete(
  '/users/:id',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const { confirmEmail } = z.object({ confirmEmail: z.string().min(1, 'Gõ lại email để xác nhận.') }).parse(req.body ?? {});
    const target = await prisma.user.findUnique({ where: { id: req.params.id } });
    if (!target) throw createError(404, 'Không tìm thấy người dùng.');
    if (normalizeEmail(confirmEmail) !== target.email) throw createError(400, 'Email xác nhận không khớp.');

    const blocked = accountChangeBlock({
      actorId: req.user!.id,
      target,
      change: { remove: true },
      otherActiveAdmins: await otherActiveAdmins(target.id),
    });
    if (blocked) throw createError(409, blocked);

    const [images, schedules] = await Promise.all([
      prisma.post.findMany({ where: { userId: target.id, imagePath: { not: null } }, select: { imagePath: true } }),
      prisma.postSchedule.findMany({ where: { userId: target.id }, select: { id: true } }),
    ]);

    // Cascades Pages, posts, targets, schedules, templates, settings, API keys
    await prisma.user.delete({ where: { id: target.id } });
    await prisma.job.deleteMany({
      where: {
        OR: [
          { payload: { path: '$.userId', equals: target.id } },
          { key: { in: schedules.map((s) => `schedule:${s.id}`) } },
        ],
      },
    });
    await Promise.all(images.map((i) => removeImage(i.imagePath)));

    logger.info('Member deleted', { adminId: req.user!.id, userId: target.id, images: images.length });
    res.json({ success: true });
  })
);

export default router;
