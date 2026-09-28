import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import '../src/config';
import prisma from '../src/utils/prisma';
import { createApp } from '../src/app';
import { startTestServer, api } from './helpers/http';
import { cleanupTestUsers, createTestUser } from './helpers/users';

let server: Awaited<ReturnType<typeof startTestServer>>;

describe.skipIf(!process.env.RUN_DB_TESTS)('Page default domain', { timeout: 60_000 }, () => {
  beforeAll(async () => {
    await cleanupTestUsers();
    server = await startTestServer(createApp());
  });
  afterAll(async () => {
    await server.close();
    await cleanupTestUsers();
    await prisma.$disconnect();
  });

  it('sets and clears the default domain; archived domains are refused; the list shows it', async () => {
    const { user, cookie } = await createTestUser();
    const page = await prisma.facebookPage.create({
      data: { userId: user.id, pageId: `PDD_${Date.now()}`, pageName: 'P', pageAccessToken: 'EAAfaketokenpagedomainxxxxxxxxxxxx' },
    });
    const domain = await prisma.contentDomain.create({ data: { userId: user.id, name: 'Nhật' } });
    const archived = await prisma.contentDomain.create({ data: { userId: user.id, name: 'Cũ', isArchived: true } });

    const set = await api(server.baseUrl, 'PATCH', `/api/pages/${page.id}`, { cookie, body: { defaultDomainId: domain.id } });
    expect(set.json.data).toEqual({ id: page.id, defaultDomainId: domain.id });
    const listed = (await api(server.baseUrl, 'GET', '/api/pages', { cookie })).json.data;
    expect(listed.find((p: { id: string }) => p.id === page.id).defaultDomainId).toBe(domain.id);

    expect((await api(server.baseUrl, 'PATCH', `/api/pages/${page.id}`, { cookie, body: { defaultDomainId: archived.id } })).status).toBe(404);
    const cleared = await api(server.baseUrl, 'PATCH', `/api/pages/${page.id}`, { cookie, body: { defaultDomainId: null } });
    expect(cleared.json.data.defaultDomainId).toBeNull();
  });
});
