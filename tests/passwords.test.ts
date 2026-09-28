import { describe, it, expect } from 'vitest';
import { hashPassword, normalizeEmail, passwordSchema, verifyPassword } from '../src/lib/passwords';

describe('passwords', () => {
  it('normalizes emails', () => {
    expect(normalizeEmail('  Lan@Example.COM ')).toBe('lan@example.com');
  });

  it('passwords need at least 8 characters', () => {
    expect(passwordSchema.safeParse('short').success).toBe(false);
    expect(passwordSchema.safeParse('8chars!!').success).toBe(true);
  });

  it('verifies bcrypt hashes and refuses placeholder hashes', async () => {
    const hash = await hashPassword('correct horse');
    expect(await verifyPassword('correct horse', hash)).toBe(true);
    expect(await verifyPassword('wrong', hash)).toBe(false);
    expect(await verifyPassword('dummy', 'dummy')).toBe(false);
    expect(await verifyPassword('x', null)).toBe(false);
  }, 20_000);
});
