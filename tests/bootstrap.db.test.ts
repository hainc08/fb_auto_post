import { describe, it, expect, afterAll } from 'vitest';
import '../src/config';
import prisma from '../src/utils/prisma';
import { assertJwtSecret, ensureAdmin } from '../src/lib/bootstrap';
import { verifyPassword } from '../src/lib/passwords';
import { DEFAULT_JWT_SECRET } from '../src/config';
import type { Prisma } from '@prisma/client';

const ROLLBACK = new Error('rollback');
async function inRollback(fn: (tx: Prisma.TransactionClient) => Promise<void>) {
  // bcrypt (cost 12) runs inside: allow more than Prisma's 5 s default
  await prisma
    .$transaction(
      async (tx) => {
        await fn(tx);
        throw ROLLBACK;
      },
      { timeout: 30_000, maxWait: 10_000 }
    )
    .catch((e) => {
      if (e !== ROLLBACK) throw e;
    });
}

describe('assertJwtSecret', () => {
  it('refuses the default or a short secret in production only', () => {
    expect(() => assertJwtSecret('production', DEFAULT_JWT_SECRET)).toThrow(/JWT_SECRET/);
    expect(() => assertJwtSecret('production', 'short')).toThrow(/JWT_SECRET/);
    expect(() => assertJwtSecret('production', 'x'.repeat(40))).not.toThrow();
    expect(() => assertJwtSecret('development', DEFAULT_JWT_SECRET)).not.toThrow();
  });
});

describe.skipIf(!process.env.RUN_DB_TESTS)('ensureAdmin', () => {
  afterAll(() => prisma.$disconnect());

  it('promotes the oldest user when nobody is ADMIN, and stays idempotent', async () => {
    await inRollback(async (tx) => {
      if ((await tx.user.count()) === 0) await tx.user.create({ data: { email: 'first@autopost.test', name: 'First' } });
      await tx.user.updateMany({ data: { role: 'USER' } });
      const oldest = await tx.user.findFirstOrThrow({ orderBy: { createdAt: 'asc' } });
      await ensureAdmin({}, tx);
      await ensureAdmin({}, tx);
      const admins = await tx.user.findMany({ where: { role: 'ADMIN' } });
      expect(admins.map((a) => a.id)).toEqual([oldest.id]);
    });
  });

  it('sets ADMIN_EMAIL/ADMIN_PASSWORD only while the admin has no real password', async () => {
    await inRollback(async (tx) => {
      if ((await tx.user.count()) === 0) await tx.user.create({ data: { email: 'first@autopost.test', name: 'First' } });
      await tx.user.updateMany({ data: { role: 'USER' } });
      const oldest = await tx.user.findFirstOrThrow({ orderBy: { createdAt: 'asc' } });
      await tx.user.update({ where: { id: oldest.id }, data: { role: 'ADMIN', passwordHash: 'dummy' } });

      await ensureAdmin({ ADMIN_EMAIL: ' Boss@AutoPost.test ', ADMIN_PASSWORD: 'first-password-1' }, tx);
      const set = await tx.user.findUniqueOrThrow({ where: { id: oldest.id } });
      expect(set.email).toBe('boss@autopost.test');
      expect(await verifyPassword('first-password-1', set.passwordHash)).toBe(true);

      await ensureAdmin({ ADMIN_EMAIL: 'boss@autopost.test', ADMIN_PASSWORD: 'second-password-2' }, tx);
      const again = await tx.user.findUniqueOrThrow({ where: { id: oldest.id } });
      expect(await verifyPassword('first-password-1', again.passwordHash)).toBe(true);
    });
  }, 30_000);
});
