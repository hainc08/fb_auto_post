import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import '../src/config';
import prisma from '../src/utils/prisma';
import { createApp } from '../src/app';
import { startTestServer, api } from './helpers/http';
import { cleanupTestUsers, createTestUser } from './helpers/users';

let server: Awaited<ReturnType<typeof startTestServer>>;

describe.skipIf(!process.env.RUN_DB_TESTS)('posts list', { timeout: 60_000 }, () => {
  beforeAll(async () => {
    server = await startTestServer(createApp());
  });
  afterAll(async () => {
    await server.close();
    await cleanupTestUsers();
    await prisma.$disconnect();
  });

  it("returns each Page's name and error, so the list can show per-Page progress", async () => {
    const { user, cookie } = await createTestUser();
    const mk = (n: string) =>
      prisma.facebookPage.create({
        data: { userId: user.id, pageId: `PL_${n}_${Date.now()}`, pageName: `Trang ${n}`, pageAccessToken: 'EAAfaketokenpostslistxxxxxxxxxxxxxx' },
      });
    const a = await mk('A');
    const b = await mk('B');
    await prisma.post.create({
      data: {
        userId: user.id,
        pageId: a.id,
        caption: 'Bài hai Page',
        status: 'FAILED',
        targets: {
          create: [
            { pageId: a.id, status: 'PUBLISHED' },
            { pageId: b.id, status: 'FAILED', errorMessage: 'Error validating access token: Session has expired' },
          ],
        },
      },
    });
    const res = await api(server.baseUrl, 'GET', '/api/posts', { cookie });
    expect(res.status).toBe(200);
    // Rows created together can share a timestamp: compare without order
    expect(res.json.data[0].targets).toHaveLength(2);
    expect(res.json.data[0].targets).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: 'PUBLISHED', errorMessage: null, page: { id: a.id, pageName: 'Trang A' } }),
      expect.objectContaining({ status: 'FAILED', errorMessage: 'Error validating access token: Session has expired', page: { id: b.id, pageName: 'Trang B' } }),
    ]));
  });
});
