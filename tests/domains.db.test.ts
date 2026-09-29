import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import '../src/config';
import prisma from '../src/utils/prisma';
import { createStarterDomains, ensureDefaultDomain, migrateDomains, resolveDomainFormat } from '../src/lib/domains';
import { cleanupTestUsers, createTestUser } from './helpers/users';

const page = (userId: string, tag: string, defaultDomainId?: string) =>
  prisma.facebookPage.create({
    data: { userId, pageId: `DOM_${tag}_${Date.now()}`, pageName: tag, pageAccessToken: 'EAAfaketokendomainsxxxxxxxxxxxxxxx', defaultDomainId },
  });

describe.skipIf(!process.env.RUN_DB_TESTS)('content domains', { timeout: 60_000 }, () => {
  beforeAll(() => cleanupTestUsers());
  afterAll(async () => {
    await cleanupTestUsers();
    await prisma.$disconnect();
  });

  it("migration turns the user's old system prompt into a verbatim legacy format, once", async () => {
    const { user } = await createTestUser();
    await prisma.setting.create({ data: { userId: user.id, key: 'systemPrompt', value: 'Prompt riêng của tôi {{topic}}' } });

    // Only this user: a global migration would also migrate other test files' users mid-run
    expect(await migrateDomains(prisma, { id: user.id })).toBe(1);
    expect(await migrateDomains(prisma, { id: user.id })).toBe(0);
    const domains = await prisma.contentDomain.findMany({ where: { userId: user.id }, include: { formats: true } });
    expect(domains).toHaveLength(1);
    expect(domains[0].name).toBe('Mặc định');
    expect(domains[0].formats).toEqual([
      expect.objectContaining({
        name: 'Bài chuẩn',
        instructions: 'Prompt riêng của tôi {{topic}}',
        isDefault: true,
        legacyPrompt: true,
        length: 'MEDIUM',
        withImage: true,
      }),
    ]);
  });

  it('users without a saved prompt get the built-in default prompt', async () => {
    const { user } = await createTestUser();
    expect(await ensureDefaultDomain(user.id)).toBe(true);
    expect(await ensureDefaultDomain(user.id)).toBe(false);
    const format = await prisma.contentFormat.findFirstOrThrow({ where: { domain: { userId: user.id } } });
    expect(format.instructions).toMatch(/^Bạn là chuyên gia viết content/);
  });

  it('new members get the starter kit: "Chung" with 3 formats, one default', async () => {
    const { user } = await createTestUser();
    await createStarterDomains(user.id);
    await createStarterDomains(user.id);
    const domains = await prisma.contentDomain.findMany({
      where: { userId: user.id },
      include: { formats: { orderBy: { sortOrder: 'asc' } } },
    });
    expect(domains.map((d) => d.name)).toEqual(['Chung']);
    expect(domains[0].formats.map((f) => [f.name, f.length, f.isDefault])).toEqual([
      ['Mẹo ngắn', 'SHORT', true],
      ['Listicle 5 ý', 'MEDIUM', false],
      ['Hỏi đáp', 'MEDIUM', false],
    ]);
  });

  it("resolves: explicit format · domain's default · Page default · first active domain", async () => {
    const { user } = await createTestUser();
    await createStarterDomains(user.id);
    const chung = await prisma.contentDomain.findFirstOrThrow({ where: { userId: user.id }, include: { formats: true } });
    const qa = chung.formats.find((f) => f.name === 'Hỏi đáp')!;
    const other = await prisma.contentDomain.create({
      data: { userId: user.id, name: 'Tiếng Nhật', sortOrder: 5, formats: { create: { name: 'Bài chuẩn', instructions: 'x', isDefault: true } } },
      include: { formats: true },
    });
    const withDefault = await page(user.id, 'withDefault', other.id);
    const archivedDefault = await prisma.contentDomain.create({ data: { userId: user.id, name: 'Cũ', isArchived: true } });
    const stale = await page(user.id, 'stale', archivedDefault.id);

    expect((await resolveDomainFormat(user.id, { formatId: qa.id })).format.id).toBe(qa.id);
    expect((await resolveDomainFormat(user.id, { domainId: chung.id })).format.name).toBe('Mẹo ngắn');
    expect((await resolveDomainFormat(user.id, { pageId: withDefault.id })).domain.id).toBe(other.id);
    expect((await resolveDomainFormat(user.id, { pageId: stale.id })).domain.id).toBe(chung.id);
    expect((await resolveDomainFormat(user.id, {})).domain.id).toBe(chung.id);
  });

  it("rejects another user's ids (404) and a format from another domain (400)", async () => {
    const a = await createTestUser();
    const b = await createTestUser();
    await createStarterDomains(a.user.id);
    await createStarterDomains(b.user.id);
    const aDomain = await prisma.contentDomain.findFirstOrThrow({ where: { userId: a.user.id } });
    const aOther = await prisma.contentDomain.create({
      data: { userId: a.user.id, name: 'Khác', formats: { create: { name: 'F', instructions: 'x', isDefault: true } } },
      include: { formats: true },
    });
    const bFormat = await prisma.contentFormat.findFirstOrThrow({ where: { domain: { userId: b.user.id } } });

    await expect(resolveDomainFormat(a.user.id, { formatId: bFormat.id })).rejects.toMatchObject({ statusCode: 404 });
    await expect(resolveDomainFormat(a.user.id, { domainId: bFormat.domainId })).rejects.toMatchObject({ statusCode: 404 });
    await expect(resolveDomainFormat(a.user.id, { domainId: aDomain.id, formatId: aOther.formats[0].id })).rejects.toMatchObject({
      statusCode: 400,
      message: 'Định dạng không thuộc lĩnh vực đã chọn.',
    });
  });

  it('a user with no domain at all gets the migrated default on first use', async () => {
    const { user } = await createTestUser();
    expect((await resolveDomainFormat(user.id, {})).format).toMatchObject({ name: 'Bài chuẩn', legacyPrompt: true });
  });
});
