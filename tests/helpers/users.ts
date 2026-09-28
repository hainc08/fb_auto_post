import { randomUUID } from 'node:crypto';
import type { User } from '@prisma/client';
import prisma from '../../src/utils/prisma';
import { hashPassword } from '../../src/lib/passwords';
import { sessionCookie } from '../../src/lib/session';

export const TEST_EMAIL_DOMAIN = '@autopost.test';

/** Per test file (vitest isolates modules per file): parallel DB test files never delete each other's users. */
const FILE_TAG = `u-${randomUUID().slice(0, 6)}-`;

/** An email this file's cleanupTestUsers() will remove. */
export const testEmail = (label: string) => `${FILE_TAG}${label}${TEST_EMAIL_DOMAIN}`;

export async function createTestUser(
  opts: Partial<Pick<User, 'role' | 'isActive' | 'name'>> & { password?: string } = {}
): Promise<{ user: User; cookie: string; password: string }> {
  const password = opts.password ?? 'test-password-123';
  const user = await prisma.user.create({
    data: {
      email: testEmail(randomUUID().slice(0, 8)),
      name: opts.name ?? 'Test User',
      passwordHash: await hashPassword(password),
      role: opts.role ?? 'USER',
      isActive: opts.isActive ?? true,
      plan: 'ENTERPRISE',
    },
  });
  return { user, cookie: sessionCookie(user), password };
}

/** Deletes this file's test users (cascades their Pages, posts, schedules, settings…). */
export const cleanupTestUsers = () =>
  prisma.user.deleteMany({ where: { email: { startsWith: FILE_TAG, endsWith: TEST_EMAIL_DOMAIN } } });
