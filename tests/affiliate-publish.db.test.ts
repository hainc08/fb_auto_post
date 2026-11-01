import { describe, it, expect, afterAll, afterEach, vi } from 'vitest';
import '../src/config';
import type { Job } from '@prisma/client';
import prisma from '../src/utils/prisma';
import { encrypt } from '../src/lib/crypto';
import { saveSettings } from '../src/lib/settings';
import { REQUIRED_SCOPES } from '../src/lib/clients/facebook';
import { GeminiClient } from '../src/lib/clients/gemini';
import { composeMessage } from '../src/lib/format-post';
import { postMessageOf, runTargetJob } from '../src/services/scheduler.service';
import { writePost } from '../src/services/post-writer';
import { getSettings } from '../src/lib/settings';
import { cleanupTestUsers, createTestUser } from './helpers/users';

const TOKEN = 'EAAfaketokenaffiliatepublishxxxxxxxx';
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const realFetch = globalThis.fetch;
const BLOCK = '🛒 Mua ở đây:\n👉 Bình xịt 16L (Shopee): https://s.shopee.vn/a';

async function setup(template: string | null, withProduct = true) {
  const { user } = await createTestUser();
  await saveSettings(user.id, { fbAppId: '111', fbAppSecret: 'fake-secret-affiliate', geminiApiKey: 'AIzaFakeKeyAffiliatePublish00000000000' });
  const tag = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const domain = await prisma.contentDomain.create({ data: { userId: user.id, name: `AF ${tag}`, firstCommentTemplate: template, formats: { create: { name: 'Bài chuẩn', instructions: 'Viết ngắn.', isDefault: true } } } });
  const page = await prisma.facebookPage.create({
    data: {
      userId: user.id,
      pageId: `AF_${tag}`,
      pageName: 'Nhà nông',
      pageAccessToken: encrypt(TOKEN),
      tokenStatus: 'VALID',
      tokenAppId: '111',
      grantedScopes: [...REQUIRED_SCOPES, 'pages_manage_engagement'],
    },
  });
  const product = await prisma.affiliateProduct.create({ data: { userId: user.id, platform: 'SHOPEE', name: 'Bình xịt 16L', url: 'https://s.shopee.vn/a', price: '450.000đ' } });
  const post = await prisma.post.create({
    data: {
      userId: user.id,
      pageId: page.id,
      domainId: domain.id,
      caption: 'Lúa vàng lá',
      hashtags: ['nhanong'],
      status: 'PUBLISHING',
      targets: { create: { pageId: page.id } },
      ...(withProduct && { products: { create: { productId: product.id } } }),
    },
    include: { targets: true },
  });
  return { user, domain, page, product, post, target: post.targets[0], feedId: `AF_POST_${tag}` };
}

/** Graph stub: records the feed message and the comment text */
function stubGraph(feedId: string) {
  const sent = { message: null as string | null, comment: null as string | null };
  vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (!url.includes('facebook.com')) return realFetch(input, init);
    const path = new URL(url).pathname;
    const body = new URLSearchParams(String(init?.body ?? ''));
    if (path.endsWith('/feed')) {
      sent.message = body.get('message');
      return json({ id: feedId });
    }
    if (path.endsWith('/comments')) {
      sent.comment = body.get('message');
      return json({ id: `${feedId}_C1` });
    }
    return json({ permalink_url: 'https://facebook.com/permalink' });
  });
  return sent;
}

const runTarget = (targetId: string, userId: string) => runTargetJob({ payload: { targetId, userId }, attempts: 1, maxAttempts: 3 } as unknown as Job);

describe.skipIf(!process.env.RUN_DB_TESTS)('affiliate products when publishing', { timeout: 60_000 }, () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  afterAll(async () => {
    await cleanupTestUsers();
    await prisma.$disconnect();
  });

  it('the published message ends with the link block and the first comment carries it', async () => {
    const s = await setup('Link mua:\n{san_pham}');
    const sent = stubGraph(s.feedId);
    await runTarget(s.target.id, s.user.id);
    expect(sent.message).toBe(`Lúa vàng lá\n\n#nhanong\n\n${BLOCK}`);
    expect(sent.comment).toBe(`Link mua:\n${BLOCK}`);
    expect(await prisma.postTarget.findUniqueOrThrow({ where: { id: s.target.id } })).toMatchObject({ status: 'PUBLISHED', firstCommentText: `Link mua:\n${BLOCK}` });
  });

  it("uses the product's current link, archived or not", async () => {
    const s = await setup(null);
    await prisma.affiliateProduct.update({ where: { id: s.product.id }, data: { url: 'https://s.shopee.vn/moi', isArchived: true } });
    const sent = stubGraph(s.feedId);
    await runTarget(s.target.id, s.user.id);
    expect(sent.message).toContain('👉 Bình xịt 16L (Shopee): https://s.shopee.vn/moi');
    expect(sent.message).not.toContain('https://s.shopee.vn/a');
  });

  it('a post without products publishes exactly as before', async () => {
    const s = await setup(null, false);
    const sent = stubGraph(s.feedId);
    await runTarget(s.target.id, s.user.id);
    expect(sent.message).toBe(composeMessage('Lúa vàng lá', ['nhanong']));
    expect(sent.comment).toBeNull();
  });

  it('the publish step stores the message with the link block', async () => {
    const s = await setup(null);
    const post = await prisma.post.findUniqueOrThrow({ where: { id: s.post.id } });
    expect(await postMessageOf(post)).toBe(`Lúa vàng lá\n\n#nhanong\n\n${BLOCK}`);
  });

  it('writing the post sends the product block to Gemini', async () => {
    const s = await setup(null);
    const gemini = vi.spyOn(GeminiClient.prototype, 'generateJson').mockResolvedValue({ post: 'Bài viết', image_prompt: 'rice' } as never);
    const post = await prisma.post.update({ where: { id: s.post.id }, data: { inputData: { basicInfo: 'Lúa vàng lá' } }, include: { template: true } });
    await writePost(post, await getSettings(s.user.id));
    const prompt = gemini.mock.calls[0][0].systemInstruction as string;
    expect(prompt).toContain('Sản phẩm cần giới thiệu trong bài');
    expect(prompt).toContain('- Bình xịt 16L — giá 450.000đ');
    expect(prompt).not.toContain('https://s.shopee.vn/a');
  });
});
