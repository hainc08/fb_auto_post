import type { Prisma } from '@prisma/client';
import prisma from '../utils/prisma';
import { createError } from '../middleware/error.middleware';
import { linkBlock, type LinkProduct } from './affiliate';

/** The affiliate products of a post (≤ 3, in order), and the schedule's rotation. */

export const MAX_POST_PRODUCTS = 3;

/**
 * Replace the post's products with `productIds`, in that order, and mark them used. 404 when one is not the
 * user's, or is archived and not already on this post (an archived product may stay where it is); 400 over the
 * limit; nothing changes then (the caller's transaction is rolled back).
 */
export async function setPostProducts(tx: Prisma.TransactionClient, userId: string, postId: string, productIds: string[]): Promise<void> {
  const ids = [...new Set(productIds)];
  if (ids.length > MAX_POST_PRODUCTS) throw createError(400, `Mỗi bài tối đa ${MAX_POST_PRODUCTS} sản phẩm.`);
  const found = await tx.affiliateProduct.count({
    where: { id: { in: ids }, userId, OR: [{ isArchived: false }, { posts: { some: { postId } } }] },
  });
  if (found !== ids.length) throw createError(404, 'Không tìm thấy sản phẩm.');
  await tx.postProduct.deleteMany({ where: { postId } });
  if (!ids.length) return;
  await tx.postProduct.createMany({ data: ids.map((productId, sortOrder) => ({ postId, productId, sortOrder })) });
  await tx.affiliateProduct.updateMany({ where: { id: { in: ids } }, data: { lastUsedAt: new Date() } });
}

export type PostProductView = LinkProduct & { id: string; isArchived: boolean };

/** The post's products as they are now (a link edited after attaching is the one published) */
export async function productsOf(postId: string, db: Prisma.TransactionClient = prisma): Promise<PostProductView[]> {
  const rows = await db.postProduct.findMany({ where: { postId }, orderBy: { sortOrder: 'asc' }, include: { product: true } });
  return rows.map(({ product: p }) => ({ id: p.id, name: p.name, url: p.url, platform: p.platform, price: p.price, highlights: p.highlights, isArchived: p.isArchived }));
}

/** What post payloads carry: the products and the link block the client previews */
export async function productsView(postId: string): Promise<{ products: PostProductView[]; affiliateBlock: string }> {
  const products = await productsOf(postId);
  return { products, affiliateBlock: linkBlock(products) };
}

/** A rotating schedule's next product: the domain's active product used least recently (never used first) */
export async function pickNextProduct(tx: Prisma.TransactionClient, userId: string, domainId: string | null): Promise<string | null> {
  if (!domainId) return null;
  const next = await tx.affiliateProduct.findFirst({
    where: { userId, domainId, isArchived: false },
    orderBy: [{ lastUsedAt: { sort: 'asc', nulls: 'first' } }, { createdAt: 'asc' }],
    select: { id: true },
  });
  return next?.id ?? null;
}
