import { Router, Response } from 'express';
import { z } from 'zod';
import prisma from '../utils/prisma';
import { AuthRequest, authenticate } from '../middleware/auth.middleware';
import { asyncHandler, createError } from '../middleware/error.middleware';

/** The member's affiliate products (Shopee, Lazada, TikTok Shop links) — "Sản phẩm affiliate". */
const router = Router();
router.use(authenticate);

export const PRODUCT_LIMIT = 200;

/** Optional text: '' clears it (null); absent stays absent (PATCH keeps the value). */
const text = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .optional()
    .transform((v) => (v === undefined ? undefined : v || null));

const httpUrl = z
  .string()
  .trim()
  .max(1000, 'Link tối đa 1000 ký tự.')
  .refine((v) => {
    try {
      return ['http:', 'https:'].includes(new URL(v).protocol);
    } catch {
      return false;
    }
  }, 'Link phải bắt đầu bằng http:// hoặc https://.');

export const productFields = {
  platform: z.enum(['SHOPEE', 'LAZADA', 'TIKTOK']),
  name: z.string().trim().min(1, 'Nhập tên sản phẩm.').max(200, 'Tên sản phẩm tối đa 200 ký tự.'),
  url: httpUrl,
  price: text(50),
  highlights: text(500),
  domainId: z.string().uuid().nullable().optional(),
};

async function ownedProduct(id: string, userId: string) {
  const product = await prisma.affiliateProduct.findFirst({ where: { id, userId } });
  if (!product) throw createError(404, 'Không tìm thấy sản phẩm.');
  return product;
}

async function assertOwnDomain(domainId: string | null | undefined, userId: string) {
  if (!domainId) return;
  if (!(await prisma.contentDomain.findFirst({ where: { id: domainId, userId, isArchived: false }, select: { id: true } }))) {
    throw createError(404, 'Lĩnh vực không tồn tại.');
  }
}

const withCount = <T extends { _count: { posts: number } }>({ _count, ...p }: T) => ({ ...p, usedCount: _count.posts });

router.get(
  '/',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const domainId = typeof req.query.domainId === 'string' ? req.query.domainId : undefined;
    const products = await prisma.affiliateProduct.findMany({
      where: { userId: req.user!.id, ...(req.query.archived === '1' ? {} : { isArchived: false }), ...(domainId && { domainId }) },
      // never used first, then the least recently used: the one to suggest next comes first
      orderBy: [{ isArchived: 'asc' }, { lastUsedAt: { sort: 'asc', nulls: 'first' } }, { createdAt: 'asc' }],
      include: { _count: { select: { posts: true } } },
    });
    res.json({ success: true, data: products.map(withCount) });
  })
);

router.post(
  '/',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const userId = req.user!.id;
    const body = z.object(productFields).parse(req.body);
    await assertOwnDomain(body.domainId, userId);
    if ((await prisma.affiliateProduct.count({ where: { userId } })) >= PRODUCT_LIMIT) {
      throw createError(409, `Tối đa ${PRODUCT_LIMIT} sản phẩm (tính cả sản phẩm đã lưu trữ).`);
    }
    const created = await prisma.affiliateProduct.create({ data: { ...body, userId } });
    res.status(201).json({ success: true, data: created });
  })
);

router.patch(
  '/:id',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const userId = req.user!.id;
    const change = z.object({ ...productFields, isArchived: z.boolean() }).partial().parse(req.body);
    const product = await ownedProduct(req.params.id, userId);
    await assertOwnDomain(change.domainId, userId);
    const updated = await prisma.affiliateProduct.update({ where: { id: product.id }, data: change });
    res.json({ success: true, data: updated });
  })
);

router.delete(
  '/:id',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const product = await ownedProduct(req.params.id, req.user!.id);
    if (await prisma.postProduct.count({ where: { productId: product.id } })) {
      throw createError(409, 'Sản phẩm đã gắn vào bài — hãy lưu trữ thay vì xoá.');
    }
    await prisma.affiliateProduct.delete({ where: { id: product.id } });
    res.json({ success: true });
  })
);

export default router;
