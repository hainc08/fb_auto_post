import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import '../src/config';
import prisma from '../src/utils/prisma';
import { getPublicSettings, getSettings, saveSettings } from '../src/lib/settings';
import { cleanupTestUsers, createTestUser } from './helpers/users';

const saved = { GEMINI_API_KEY: process.env.GEMINI_API_KEY, FACEBOOK_APP_ID: process.env.FACEBOOK_APP_ID };
const restore = (key: keyof typeof saved) => {
  if (saved[key] === undefined) delete process.env[key];
  else process.env[key] = saved[key];
};

describe.skipIf(!process.env.RUN_DB_TESTS)('settings env fallback', () => {
  beforeAll(async () => {
    process.env.GEMINI_API_KEY = 'AIzaEnvFallbackKeyForTests000000000000';
    process.env.FACEBOOK_APP_ID = '123456789';
  });
  afterAll(async () => {
    restore('GEMINI_API_KEY');
    restore('FACEBOOK_APP_ID');
    await cleanupTestUsers();
    await prisma.$disconnect();
  });

  it('members never borrow the server .env keys', async () => {
    const { user } = await createTestUser();
    const s = await getSettings(user.id);
    expect(s.geminiApiKey).toBe('');
    expect(s.fbAppId).toBe('');
    expect(s.geminiModel).toBe('gemini-2.5-flash'); // non-secret defaults still apply
    expect((await getPublicSettings(user.id)).geminiApiKey).toMatchObject({ source: 'none' });
  });

  it('their own saved keys work', async () => {
    const { user } = await createTestUser();
    await saveSettings(user.id, { geminiApiKey: 'AIzaUserOwnKey00000000000000000000000' });
    expect((await getSettings(user.id)).geminiApiKey).toBe('AIzaUserOwnKey00000000000000000000000');
  });

  it('ADMIN keeps the .env fallback (production stays as it is)', async () => {
    const { user } = await createTestUser({ role: 'ADMIN' });
    expect((await getSettings(user.id)).geminiApiKey).toBe('AIzaEnvFallbackKeyForTests000000000000');
    expect((await getPublicSettings(user.id)).geminiApiKey).toMatchObject({ source: 'env' });
  });
});
