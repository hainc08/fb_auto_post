import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import '../src/config';
import prisma from '../src/utils/prisma';
import { createApp, API_ROUTERS } from '../src/app';
import { removeImage, saveImage } from '../src/lib/image-store';
import { removeVideo, saveUploadedVideo, VIDEO_TMP_DIR } from '../src/lib/video-store';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tinyMp4 } from './helpers/mp4';
import { startTestServer, api } from './helpers/http';
import { cleanupTestUsers, createTestUser } from './helpers/users';

/**
 * User A must never read or change user B's data through any API route.
 * Stop dev servers first (their worker would take jobs queued here).
 */

/** Every route as "METHOD /api/mount/path" (array paths expanded). */
function listApiRoutes(): string[] {
  const out: string[] = [];
  for (const [mount, router] of API_ROUTERS) {
    type Layer = { route?: { path: string | string[]; methods: Record<string, boolean> } };
    for (const layer of (router as unknown as { stack: Layer[] }).stack) {
      if (!layer.route) continue;
      const paths = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path];
      for (const method of Object.keys(layer.route.methods)) {
        for (const p of paths) out.push(`${method.toUpperCase()} ${mount}${p === '/' ? '' : p}`);
      }
    }
  }
  return out.sort();
}

type Ids = { postId: string; pageId: string; targetId: string; commentId: string; scheduleId: string; ideaId: string; templateId: string; domainId: string; formatId: string };
type Case =
  | { kind: 'foreign-id'; path: (b: Ids) => string; body?: unknown } // must 404
  | { kind: 'list'; path: string } // must not contain B's markers
  | { kind: 'own-scope'; path: string; body?: unknown; why: string } // takes no foreign id; must not touch B
  | { kind: 'admin-only' } // covered by admin.db.test.ts
  | { kind: 'public'; why: string };

const ROUTE_CASES: Record<string, Case> = {
  'POST /api/auth/login': { kind: 'public', why: 'đăng nhập' },
  'POST /api/auth/logout': { kind: 'public', why: 'chỉ xoá cookie' },
  'GET /api/auth/me': { kind: 'list', path: '/api/auth/me' },
  'POST /api/auth/api-keys': { kind: 'own-scope', path: '/api/auth/api-keys', body: { name: 'iso' }, why: 'gắn req.user.id' },
  'GET /api/admin/users': { kind: 'admin-only' },
  'POST /api/admin/users': { kind: 'admin-only' },
  'PATCH /api/admin/users/:id': { kind: 'admin-only' },
  'DELETE /api/admin/users/:id': { kind: 'admin-only' },
  'GET /api/pages': { kind: 'list', path: '/api/pages' },
  'POST /api/pages/sync/preview': {
    kind: 'own-scope',
    path: '/api/pages/sync/preview',
    body: { userToken: 'EAAinvalidinvalidinvalidinvalid' },
    why: 'token của chính user; không nhận id',
  },
  'POST /api/pages/sync/apply': {
    kind: 'own-scope',
    path: '/api/pages/sync/apply',
    body: { refs: [], disconnect: [] },
    why: 'ref gắn userId; disconnect lọc userId',
  },
  'POST /api/pages/check': { kind: 'own-scope', path: '/api/pages/check', why: 'chỉ Page của user' },
  'POST /api/pages/:id/check': { kind: 'foreign-id', path: (b) => `/api/pages/${b.pageId}/check` },
  'POST /api/pages/connect': { kind: 'own-scope', path: '/api/pages/connect', body: { pages: [] }, why: 'upsert theo (userId, pageId)' },
  'DELETE /api/pages/:id': { kind: 'foreign-id', path: (b) => `/api/pages/${b.pageId}` },
  'POST /api/pages/:id/refresh-token': {
    kind: 'foreign-id',
    path: (b) => `/api/pages/${b.pageId}/refresh-token`,
    body: { accessToken: 'EAAx' },
  },
  'PATCH /api/pages/:id': { kind: 'foreign-id', path: (b) => `/api/pages/${b.pageId}`, body: { defaultDomainId: null } },
  'GET /api/templates': { kind: 'list', path: '/api/templates' },
  'GET /api/templates/:id': { kind: 'foreign-id', path: (b) => `/api/templates/${b.templateId}` },
  'POST /api/templates': {
    kind: 'own-scope',
    path: '/api/templates',
    body: { name: 'iso', promptTemplate: 'viết một bài ngắn' },
    why: 'gắn req.user.id',
  },
  'PUT /api/templates/:id': { kind: 'foreign-id', path: (b) => `/api/templates/${b.templateId}`, body: { name: 'hack' } },
  'DELETE /api/templates/:id': { kind: 'foreign-id', path: (b) => `/api/templates/${b.templateId}` },
  'GET /api/posts': { kind: 'list', path: '/api/posts' },
  'GET /api/posts/:id': { kind: 'foreign-id', path: (b) => `/api/posts/${b.postId}` },
  'POST /api/posts': { kind: 'foreign-id', path: () => '/api/posts' }, // body = B's pageIds (below)
  'PATCH /api/posts/:id': { kind: 'foreign-id', path: (b) => `/api/posts/${b.postId}`, body: { caption: 'hack' } },
  'POST /api/posts/:id/generate': { kind: 'foreign-id', path: (b) => `/api/posts/${b.postId}/generate`, body: {} },
  'POST /api/posts/:id/preview-image': { kind: 'foreign-id', path: (b) => `/api/posts/${b.postId}/preview-image`, body: {} },
  'POST /api/posts/:id/image/generate': { kind: 'foreign-id', path: (b) => `/api/posts/${b.postId}/image/generate`, body: {} },
  'POST /api/posts/:id/image/upload': { kind: 'foreign-id', path: (b) => `/api/posts/${b.postId}/image/upload`, body: {} },
  'DELETE /api/posts/:id/image': { kind: 'foreign-id', path: (b) => `/api/posts/${b.postId}/image` },
  'POST /api/posts/:id/improve': { kind: 'foreign-id', path: (b) => `/api/posts/${b.postId}/improve`, body: { instruction: 'ngắn hơn' } },
  'GET /api/posts/:id/comments': { kind: 'foreign-id', path: (b) => `/api/posts/${b.postId}/comments` },
  'POST /api/posts/:id/comments/refresh': { kind: 'foreign-id', path: (b) => `/api/posts/${b.postId}/comments/refresh` },
  'POST /api/posts/:id/comments/:commentId/reply': { kind: 'foreign-id', path: (b) => `/api/posts/${b.postId}/comments/${b.commentId}/reply`, body: { message: 'hack' } },
  'PATCH /api/posts/:id/comments/:commentId': { kind: 'foreign-id', path: (b) => `/api/posts/${b.postId}/comments/${b.commentId}`, body: { handled: true } },
  'DELETE /api/posts/:id/comments/:commentId/draft': { kind: 'foreign-id', path: (b) => `/api/posts/${b.postId}/comments/${b.commentId}/draft` },
  'POST /api/posts/:id/comments/send-drafts': { kind: 'foreign-id', path: (b) => `/api/posts/${b.postId}/comments/send-drafts` },
  'PATCH /api/posts/:id/comments/auto-reply': { kind: 'foreign-id', path: (b) => `/api/posts/${b.postId}/comments/auto-reply`, body: { off: true } },
  'POST /api/posts/:id/approve': { kind: 'foreign-id', path: (b) => `/api/posts/${b.postId}/approve` },
  'POST /api/posts/:id/schedule': {
    kind: 'foreign-id',
    path: (b) => `/api/posts/${b.postId}/schedule`,
    body: { scheduledAt: new Date(Date.now() + 3 * 3600_000).toISOString() },
  },
  'DELETE /api/posts/:id/schedule': { kind: 'foreign-id', path: (b) => `/api/posts/${b.postId}/schedule` },
  'POST /api/posts/:id/publish': { kind: 'foreign-id', path: (b) => `/api/posts/${b.postId}/publish`, body: {} },
  'POST /api/posts/:id/targets/:targetId/retry': {
    kind: 'foreign-id',
    path: (b) => `/api/posts/${b.postId}/targets/${b.targetId}/retry`,
  },
  'DELETE /api/posts/:id': { kind: 'foreign-id', path: (b) => `/api/posts/${b.postId}` },
  'GET /api/schedules': { kind: 'list', path: '/api/schedules' },
  'GET /api/schedules/:id': { kind: 'foreign-id', path: (b) => `/api/schedules/${b.scheduleId}` },
  'POST /api/schedules': { kind: 'foreign-id', path: () => '/api/schedules' }, // body = B's pageIds (below)
  'PUT /api/schedules/:id': { kind: 'foreign-id', path: (b) => `/api/schedules/${b.scheduleId}`, body: { name: 'hack' } },
  'PATCH /api/schedules/:id/toggle': { kind: 'foreign-id', path: (b) => `/api/schedules/${b.scheduleId}/toggle` },
  'DELETE /api/schedules/:id': { kind: 'foreign-id', path: (b) => `/api/schedules/${b.scheduleId}` },
  'POST /api/schedules/:id/ideas': { kind: 'foreign-id', path: (b) => `/api/schedules/${b.scheduleId}/ideas`, body: { texts: ['hack idea'] } },
  'DELETE /api/schedules/:id/ideas/:ideaId': { kind: 'foreign-id', path: (b) => `/api/schedules/${b.scheduleId}/ideas/${b.ideaId}` },
  'POST /api/schedules/:id/ideas/suggest': { kind: 'foreign-id', path: (b) => `/api/schedules/${b.scheduleId}/ideas/suggest` },
  'PUT /api/schedules/:id/ideas/order': { kind: 'foreign-id', path: (b) => `/api/schedules/${b.scheduleId}/ideas/order`, body: { ids: [] } },
  'GET /api/analytics/overview': { kind: 'list', path: '/api/analytics/overview' },
  'GET /api/analytics/posts-timeline': { kind: 'list', path: '/api/analytics/posts-timeline' },
  'GET /api/analytics/pages-performance': { kind: 'list', path: '/api/analytics/pages-performance' },
  'GET /api/settings': { kind: 'list', path: '/api/settings' },
  'POST /api/settings': { kind: 'own-scope', path: '/api/settings', body: { geminiModel: 'gemini-2.5-flash' }, why: 'ghi settings của req.user' },
  'POST /api/settings/test/:group': { kind: 'foreign-id', path: () => '/api/settings/test/facebook' }, // body = B's pageId (below)
  'POST /api/settings/facebook/exchange-token': {
    kind: 'own-scope',
    path: '/api/settings/facebook/exchange-token',
    body: { shortToken: 'EAAinvalidinvalidinvalidinvalid' },
    why: 'token của chính user',
  },
  'POST /api/settings/facebook/pages': { kind: 'own-scope', path: '/api/settings/facebook/pages', body: { refs: ['bad'] }, why: 'ref do server mã hoá' },
  'POST /api/settings/facebook/pages/manual': {
    kind: 'own-scope',
    path: '/api/settings/facebook/pages/manual',
    body: { pageId: '1', pageAccessToken: 'EAAinvalidinvalidinvalid' },
    why: 'upsert theo (userId, pageId)',
  },
  'GET /api/domains': { kind: 'list', path: '/api/domains?archived=1' },
  'POST /api/domains': {
    kind: 'own-scope',
    path: '/api/domains',
    body: { name: 'iso', format: { name: 'f', instructions: 'x' } },
    why: 'gắn req.user.id',
  },
  'PATCH /api/domains/:id': { kind: 'foreign-id', path: (b) => `/api/domains/${b.domainId}`, body: { name: 'hack' } },
  'DELETE /api/domains/:id': { kind: 'foreign-id', path: (b) => `/api/domains/${b.domainId}` },
  'POST /api/domains/:id/formats': {
    kind: 'foreign-id',
    path: (b) => `/api/domains/${b.domainId}/formats`,
    body: { name: 'hack', instructions: 'x' },
  },
  'PATCH /api/formats/:id': { kind: 'foreign-id', path: (b) => `/api/formats/${b.formatId}`, body: { name: 'hack' } },
  'DELETE /api/formats/:id': { kind: 'foreign-id', path: (b) => `/api/formats/${b.formatId}` },
  'POST /api/formats/:id/preview': { kind: 'foreign-id', path: (b) => `/api/formats/${b.formatId}/preview`, body: { idea: 'x' } },
  'POST /api/posts/:id/video/upload': { kind: 'foreign-id', path: (b) => `/api/posts/${b.postId}/video/upload`, body: {} },
  'DELETE /api/posts/:id/video': { kind: 'foreign-id', path: (b) => `/api/posts/${b.postId}/video` },
  'GET /api/posts/reel/status': { kind: 'list', path: '/api/posts/reel/status' },
  'GET /api/posts/:id/reel/progress': { kind: 'foreign-id', path: (b) => `/api/posts/${b.postId}/reel/progress` },
  'POST /api/posts/:id/reel/script': { kind: 'foreign-id', path: (b) => `/api/posts/${b.postId}/reel/script` },
  'GET /api/posts/:id/reel/draft': { kind: 'foreign-id', path: (b) => `/api/posts/${b.postId}/reel/draft` },
  'PUT /api/posts/:id/reel/draft': { kind: 'foreign-id', path: (b) => `/api/posts/${b.postId}/reel/draft`, body: { scenes: [{ text: 'hack' }] } },
  'POST /api/posts/:id/reel/scenes/:sceneId/image/generate': { kind: 'foreign-id', path: (b) => `/api/posts/${b.postId}/reel/scenes/00000000/image/generate` },
  'POST /api/posts/:id/reel/scenes/:sceneId/image/upload': { kind: 'foreign-id', path: (b) => `/api/posts/${b.postId}/reel/scenes/00000000/image/upload`, body: {} },
  'DELETE /api/posts/:id/reel/scenes/:sceneId/image': { kind: 'foreign-id', path: (b) => `/api/posts/${b.postId}/reel/scenes/00000000/image` },
  'GET /api/posts/:id/reel/scenes/:sceneId/image': { kind: 'foreign-id', path: (b) => `/api/posts/${b.postId}/reel/scenes/00000000/image` },
  'POST /api/posts/:id/reel': { kind: 'foreign-id', path: (b) => `/api/posts/${b.postId}/reel`, body: { script: 'Một kịch bản thử có đủ năm từ.' } },
  'GET /api/videos/:postId': { kind: 'foreign-id', path: (b) => `/api/videos/${b.postId}` },
  'GET /api/images/:postId': { kind: 'foreign-id', path: (b) => `/api/images/${b.postId}` },
};

const B_MARK = 'ISO_B_SECRET_MARK';
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('img')]);
let server: Awaited<ReturnType<typeof startTestServer>>;
let aCookie: string;
let aOwn: { pageId: string; scheduleId: string };
let b: Ids;
let bImagePath: string;
let bVideoPath: string;

describe.skipIf(!process.env.RUN_DB_TESTS)('data isolation between users', { timeout: 120_000 }, () => {
  // The server runs in this process: never let a route reach the real Graph API with fake tokens
  const realFetch = globalThis.fetch;
  beforeEach(() => {
    vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) =>
      String(input instanceof Request ? input.url : input).includes('graph.facebook.com')
        ? Promise.resolve(new Response(JSON.stringify({ error: { message: 'blocked in test', code: 190 } }), { status: 400 }))
        : realFetch(input, init)
    );
  });

  beforeAll(async () => {
    server = await startTestServer(createApp());
    const a = await createTestUser({ name: 'User A' });
    aCookie = a.cookie;
    const aPage = await prisma.facebookPage.create({
      data: { userId: a.user.id, pageId: 'ISO_A_PAGE', pageName: 'A Page', pageAccessToken: 'EAAisolationfaketokenaaaaaaaaaaaa' },
    });
    const aSchedule = await prisma.postSchedule.create({
      data: {
        userId: a.user.id,
        pageId: aPage.id,
        name: 'A lịch',
        frequency: 'SLOTS',
        weekdays: [1],
        slots: ['08:00'],
        startDate: new Date(Date.now() + 86_400_000),
        pages: { create: { pageId: aPage.id } },
      },
    });
    aOwn = { pageId: aPage.id, scheduleId: aSchedule.id };
    const { user: userB } = await createTestUser({ name: 'User B' });
    const page = await prisma.facebookPage.create({
      data: { userId: userB.id, pageId: 'ISO_B_PAGE', pageName: `${B_MARK} Page`, pageAccessToken: 'EAAisolationfaketokenxxxxxxxxxxxx' },
    });
    const post = await prisma.post.create({
      data: {
        userId: userB.id,
        pageId: page.id,
        caption: `${B_MARK} caption`,
        status: 'FAILED',
        targets: { create: [{ pageId: page.id, status: 'FAILED', fbPostId: `ISO_B_FB_${Date.now()}` }] },
      },
      include: { targets: true },
    });
    // A real image file, so the image route would serve it if ownership were not checked
    bImagePath = (await saveImage(post.id, PNG)).imagePath;
    await prisma.post.update({ where: { id: post.id }, data: { imagePath: bImagePath } });
    // A real video file, so the video route would serve it if ownership were not checked
    await mkdir(VIDEO_TMP_DIR, { recursive: true });
    const tmp = path.join(VIDEO_TMP_DIR, `iso-${post.id}.upload`);
    await writeFile(tmp, tinyMp4({ durationSec: 5, width: 640, height: 360 }));
    const storedVideo = await saveUploadedVideo(post.id, tmp);
    bVideoPath = storedVideo.videoPath;
    await prisma.post.update({ where: { id: post.id }, data: { videoPath: storedVideo.videoPath, videoUrl: storedVideo.videoUrl, videoMime: storedVideo.mime } });
    const schedule = await prisma.postSchedule.create({
      data: {
        userId: userB.id,
        pageId: page.id,
        name: `${B_MARK} lịch`,
        frequency: 'SLOTS',
        weekdays: [1],
        slots: ['08:00'],
        startDate: new Date(Date.now() + 86_400_000),
        pages: { create: { pageId: page.id } },
        ideas: { create: { text: `${B_MARK} ý tưởng`, position: 0 } },
      },
      include: { ideas: true },
    });
    const template = await prisma.contentTemplate.create({ data: { userId: userB.id, name: `${B_MARK} mẫu`, promptTemplate: 'mẫu của B' } });
    const domain = await prisma.contentDomain.create({
      data: {
        userId: userB.id,
        name: `${B_MARK} lĩnh vực`,
        formats: { create: { name: `${B_MARK} định dạng`, instructions: 'của B', isDefault: true } },
      },
      include: { formats: true },
    });
    b = {
      postId: post.id,
      pageId: page.id,
      targetId: post.targets[0].id,
      commentId: (
        await prisma.postComment.create({
          data: { targetId: post.targets[0].id, fbCommentId: `ISO_B_COMMENT_${Date.now()}`, message: `${B_MARK} bình luận`, commentedAt: new Date() },
        })
      ).id,
      scheduleId: schedule.id,
      ideaId: schedule.ideas[0].id,
      templateId: template.id,
      domainId: domain.id,
      formatId: domain.formats[0].id,
    };
  });

  afterAll(async () => {
    await server.close();
    await removeImage(bImagePath);
    await removeVideo(bVideoPath);
    await cleanupTestUsers();
    await prisma.$disconnect();
  });

  it('every API route is declared in ROUTE_CASES (new routes must be added)', () => {
    expect(listApiRoutes()).toEqual(Object.keys(ROUTE_CASES).sort());
  });

  it("user A gets 404 on every route that takes user B's ids", async () => {
    const bodies: Record<string, unknown> = {
      'POST /api/posts': { pageIds: [b.pageId], inputData: { basicInfo: 'x' } },
      'POST /api/schedules': { pageIds: [b.pageId], name: 'x', weekdays: [1], slots: ['08:00'] },
      'POST /api/settings/test/:group': { pageId: b.pageId },
    };
    const failures: string[] = [];
    for (const [route, c] of Object.entries(ROUTE_CASES)) {
      if (c.kind !== 'foreign-id') continue;
      const method = route.split(' ')[0];
      const res = await api(server.baseUrl, method, c.path(b), { cookie: aCookie, body: bodies[route] ?? c.body });
      if (res.status !== 404) failures.push(`${route} → ${res.status} ${res.text.slice(0, 120)}`);
    }
    expect(failures).toEqual([]);
  });

  it("lists and own-scope routes never show user B's data", async () => {
    const leaks: string[] = [];
    for (const [route, c] of Object.entries(ROUTE_CASES)) {
      if (c.kind !== 'list' && c.kind !== 'own-scope') continue;
      const method = route.split(' ')[0];
      const res = await api(server.baseUrl, method, c.path, { cookie: aCookie, body: c.kind === 'own-scope' ? c.body : undefined });
      if (res.text.includes(B_MARK) || res.text.includes(b.postId) || res.text.includes(b.pageId)) leaks.push(route);
    }
    expect(leaks).toEqual([]);
  });

  it("user A cannot attach user B's Page or template to A's own posts and schedules (ids in the body)", async () => {
    const attempts: Array<[string, string, unknown]> = [
      ['PUT', `/api/schedules/${aOwn.scheduleId}`, { pageIds: [b.pageId] }],
      ['POST', '/api/posts', { pageIds: [aOwn.pageId], templateId: b.templateId, inputData: { basicInfo: 'x' } }],
      ['POST', '/api/posts', { pageIds: [aOwn.pageId], domainId: b.domainId, inputData: { basicInfo: 'x' } }],
      ['POST', '/api/posts', { pageIds: [aOwn.pageId], formatId: b.formatId, inputData: { basicInfo: 'x' } }],
      ['PATCH', `/api/pages/${aOwn.pageId}`, { defaultDomainId: b.domainId }],
      ['PUT', `/api/schedules/${aOwn.scheduleId}`, { domainId: b.domainId }],
      ['POST', '/api/schedules', { pageIds: [aOwn.pageId], formatId: b.formatId, name: 'x', weekdays: [1], slots: ['08:00'] }],
    ];
    const failures: string[] = [];
    for (const [method, path, body] of attempts) {
      const res = await api(server.baseUrl, method, path, { cookie: aCookie, body });
      if (res.status !== 404) failures.push(`${method} ${path} ${JSON.stringify(body)} → ${res.status} ${res.text.slice(0, 100)}`);
    }
    expect(failures).toEqual([]);
    expect(await prisma.facebookPage.findUnique({ where: { id: aOwn.pageId } })).toMatchObject({ defaultDomainId: null });
    expect(await prisma.postSchedule.findUnique({ where: { id: aOwn.scheduleId } })).toMatchObject({ pageId: aOwn.pageId, domainId: null });
    expect(await prisma.schedulePage.count({ where: { scheduleId: aOwn.scheduleId, pageId: b.pageId } })).toBe(0);
  });

  it("user B's data is intact after all of A's attempts", async () => {
    expect(await prisma.post.findUnique({ where: { id: b.postId } })).toMatchObject({ caption: `${B_MARK} caption` });
    expect(await prisma.facebookPage.findUnique({ where: { id: b.pageId } })).toMatchObject({ isActive: true });
    expect(await prisma.postSchedule.findUnique({ where: { id: b.scheduleId } })).toMatchObject({ name: `${B_MARK} lịch`, isActive: true });
    expect(await prisma.scheduleIdea.findUnique({ where: { id: b.ideaId } })).toMatchObject({ status: 'QUEUED' });
    expect(await prisma.contentTemplate.findUnique({ where: { id: b.templateId } })).toMatchObject({ name: `${B_MARK} mẫu` });
    expect(await prisma.contentDomain.findUnique({ where: { id: b.domainId } })).toMatchObject({ name: `${B_MARK} lĩnh vực`, isArchived: false });
    expect(await prisma.contentFormat.findUnique({ where: { id: b.formatId } })).toMatchObject({ name: `${B_MARK} định dạng` });
    expect(await prisma.facebookPage.findUnique({ where: { id: b.pageId } })).toMatchObject({ defaultDomainId: null });
  });
});
