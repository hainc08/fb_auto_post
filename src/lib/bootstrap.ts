import type { Prisma } from '@prisma/client';
import prisma from '../utils/prisma';
import { config, DEFAULT_JWT_SECRET } from '../config';
import { logger } from '../utils/logger';
import { hashPassword, normalizeEmail, passwordSchema } from './passwords';

/** Sessions are only as safe as the signing key. */
export function assertJwtSecret(env: string = config.env, secret: string = config.jwt.secret): void {
  if (env !== 'production') return;
  if (!secret || secret === DEFAULT_JWT_SECRET || secret.length < 32) {
    throw new Error('JWT_SECRET phải là chuỗi ngẫu nhiên từ 32 ký tự trở lên trong production.');
  }
}

/**
 * One guaranteed way in: an ADMIN always exists, and on the first deploy the old
 * bypass user ("dummy" password) gets ADMIN_EMAIL / ADMIN_PASSWORD.
 * Idempotent; never overwrites a real password.
 */
export async function ensureAdmin(env: NodeJS.ProcessEnv = process.env, db: Prisma.TransactionClient = prisma): Promise<void> {
  let admin = await db.user.findFirst({ where: { role: 'ADMIN' }, orderBy: { createdAt: 'asc' } });

  if (!admin) {
    const oldest = await db.user.findFirst({ orderBy: { createdAt: 'asc' } });
    if (oldest) {
      admin = await db.user.update({ where: { id: oldest.id }, data: { role: 'ADMIN', isActive: true } });
      logger.info('[Bootstrap] Oldest user promoted to ADMIN', { userId: admin.id });
    } else if (env.ADMIN_EMAIL && env.ADMIN_PASSWORD && passwordSchema.safeParse(env.ADMIN_PASSWORD).success) {
      admin = await db.user.create({
        data: {
          email: normalizeEmail(env.ADMIN_EMAIL),
          name: 'Admin',
          role: 'ADMIN',
          plan: 'ENTERPRISE',
          passwordHash: await hashPassword(env.ADMIN_PASSWORD),
        },
      });
      logger.info('[Bootstrap] ADMIN created from ADMIN_EMAIL', { userId: admin.id });
      return;
    } else {
      logger.warn('[Bootstrap] Chưa có user nào: đặt ADMIN_EMAIL + ADMIN_PASSWORD (≥ 8 ký tự) rồi khởi động lại.');
      return;
    }
  }

  if (admin.passwordHash?.startsWith('$2')) return;

  if (!env.ADMIN_EMAIL || !env.ADMIN_PASSWORD) {
    logger.warn('[Bootstrap] Admin chưa có mật khẩu: đặt ADMIN_EMAIL + ADMIN_PASSWORD rồi khởi động lại.');
    return;
  }
  const password = passwordSchema.safeParse(env.ADMIN_PASSWORD);
  if (!password.success) {
    logger.error('[Bootstrap] ADMIN_PASSWORD cần ít nhất 8 ký tự — bỏ qua.');
    return;
  }
  const email = normalizeEmail(env.ADMIN_EMAIL);
  if (await db.user.findFirst({ where: { email, NOT: { id: admin.id } } })) {
    logger.error('[Bootstrap] ADMIN_EMAIL đã thuộc tài khoản khác — bỏ qua.', { email });
    return;
  }
  await db.user.update({
    where: { id: admin.id },
    data: { email, passwordHash: await hashPassword(password.data), tokenVersion: { increment: 1 } },
  });
  logger.info('[Bootstrap] Admin credentials set from ADMIN_EMAIL / ADMIN_PASSWORD', { email });
}

export async function runBootstrap(): Promise<void> {
  assertJwtSecret();
  await ensureAdmin();
}
