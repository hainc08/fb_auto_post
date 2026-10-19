import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import '../src/config';
import prisma from '../src/utils/prisma';
import { createApp } from '../src/app';
import { encrypt } from '../src/lib/crypto';
import { saveSettings } from '../src/lib/settings';
import { FacebookClient, REQUIRED_SCOPES } from '../src/lib/clients/facebook';
import { startTestServer, api } from './helpers/http';
import { cleanupTestUsers, createTestUser } from './helpers/users';

let server: Awaited<ReturnType<typeof startTestServer>>;
const TOKEN = 'EAAfaketokenfirstcommentroutexxxxxxxxxx';

async function setup(template: string | null, published = true) {
  const { user, cookie } = await createTestUser();
  await saveSettings(user.id, { fbAppId: '111', fbAppSecret: 'fake-secret-fc-route' });
  const tag = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const domain = await prisma.contentDomain.create({ data: { userId: user.id, name: `FCR ${tag}`, firstCommentTemplate: template } });
  const page = await prisma.facebookPage.create({
    data: { userId: user.id, pageId: `FCR_${tag}`, pageName: 'Nhà nông', pageAccessToken: encrypt(TOKEN), tokenStatus: 'VALID', tokenAppId: '111', grantedScopes: [...REQUIRED_SCOPES, 'pages_manage_engagement'] },
  });
  const post = await prisma.post.create({
    data: {
      userId: user.id,
      pageId: page.id,
      domainId: domain.id,
      caption: 'x',
      status: published ? 'PUBLISHED' : 'READY',
      targets: { create: { pageId: page.id, status: published ? 'PUBLISHED' : 'PENDING', fbPostId: published ? `FCR_POST_${tag}` : null, publishedAt: published ? new Date() : null, firstCommentError: 'Facebook từ chối trước đó' } },
    },
    include: { targets: true },
  });
  return { cookie, post, target: post.targets[0] };
}

describe.skipIf(!process.env.RUN_DB_TESTS)('re-post a failed first comment', { timeout: 60_000 }, () => {
  beforeAll(async () => {
    server = await startTestServer(createApp());
  });
  afterAll(async () => {
    await server.close();
    await cleanupTestUsers();
    await prisma.$disconnect();
  });

  const repost = (cookie: string, postId: string, targetId: string) => api(server.baseUrl, 'POST', `/api/posts/${postId}/targets/${targetId}/first-comment`, { cookie });

  it('posts the first comment again after a failure, and records it', async () => {
    const s = await setup('Link: https://example.com/c');
    vi.spyOn(FacebookClient.prototype, 'createComment').mockResolvedValue({ id: 'FCR_C_1' });
    const res = await repost(s.cookie, s.post.id, s.target.id);
    expect(res.status).toBe(200);
    expect(res.json.data).toEqual({ status: 'posted', error: null });
    expect(await prisma.postTarget.findUniqueOrThrow({ where: { id: s.target.id } })).toMatchObject({ firstCommentId: 'FCR_C_1', firstCommentError: null });
    // already posted: no second comment
    const again = await repost(s.cookie, s.post.id, s.target.id);
    expect(again.json.data.status).toBe('already');
  });

  it('a Page that has not published the post cannot get a first comment yet (409)', async () => {
    const s = await setup('Link', false);
    const res = await repost(s.cookie, s.post.id, s.target.id);
    expect(res.status).toBe(409);
    expect(res.json.error).toMatch(/chưa lên Page này/);
  });

  it('a domain with no template is refused (400) and nothing is sent', async () => {
    const s = await setup('   ');
    const spy = vi.spyOn(FacebookClient.prototype, 'createComment').mockResolvedValue({ id: 'never' });
    const res = await repost(s.cookie, s.post.id, s.target.id);
    expect(res.status).toBe(400);
    expect(res.json.error).toMatch(/chưa có mẫu bình luận đầu/);
    expect(spy).not.toHaveBeenCalled();
  });

  it('another member gets 404 for the post and its Page', async () => {
    const s = await setup('Link');
    const other = await createTestUser();
    const spy = vi.spyOn(FacebookClient.prototype, 'createComment').mockResolvedValue({ id: 'never' });
    expect((await repost(other.cookie, s.post.id, s.target.id)).status).toBe(404);
    expect(spy).not.toHaveBeenCalled();
  });
});
