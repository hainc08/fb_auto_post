import { randomUUID } from 'node:crypto';
import type { User } from '@prisma/client';
import prisma from '../../src/utils/prisma';
import { hashPassword } from '../../src/lib/passwords';
import { sessionCookie } from '../../src/lib/session';

export const TEST_EMAIL_DOMAIN = '@autopost.test';

export async function createTestUser(
  opts: Partial<Pick<User, 'role' | 'isActive' | 'name'>> & { password?: string } = {}
): Promise<{ user: User; cookie: string; password: string }> {
  const password = opts.password ?? 'test-password-123';
  const user = await prisma.user.create({
    data: {
      email: `u-${randomUUID().slice(0, 8)}${TEST_EMAIL_DOMAIN}`,
      name: opts.name ?? 'Test User',
      passwordHash: await hashPassword(password),
      role: opts.role ?? 'USER',
      isActive: opts.isActive ?? true,
      plan: 'ENTERPRISE',
    },
  });
  return { user, cookie: sessionCookie(user), password };
}

/** Deletes every test user (cascades their Pages, posts, schedules, settings…). */
export const cleanupTestUsers = () => prisma.user.deleteMany({ where: { email: { endsWith: TEST_EMAIL_DOMAIN } } });
