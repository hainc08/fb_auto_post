import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import '../src/config';
import prisma from '../src/utils/prisma';
import { encrypt } from '../src/lib/crypto';
import { saveSettings } from '../src/lib/settings';
import { runEngagementSync, COMMENTS_NEED_RESYNC } from '../src/services/engagement-sync';
import { cleanupTestUsers, createTestUser } from './helpers/users';

const READ = ['pages_manage_posts', 'pages_read_engagement', 'pages_show_list', 'pages_read_user_content'];
let userId: string;
const now = new Date('2026-09-30T10:00:00Z');
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const uniq = () => `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

async function page(fbId: string, scopes = READ, extra: Record<string, unknown> = {}) {
  return prisma.facebookPage.create({
    data: { userId, pageId: fbId, pageName: `Page ${fbId}`, pageAccessToken: encrypt(`EAAtoken${fbId}xxxxxxxxxxxxxxxxxxxx`), tokenStatus: 'VALID', grantedScopes: scopes, ...extra },
  });
}
async function published(pageDbId: string, fbPostId: string, daysAgo = 1) {
  const post = await prisma.post.create({
    data: {
      userId,
      pageId: pageDbId,
      caption: 'x',
      status: 'PUBLISHED',
      targets: { create: { pageId: pageDbId, status: 'PUBLISHED', fbPostId, publishedAt: new Date(now.getTime() - daysAgo * 86_400_000) } },
    },
    include: { targets: true },
  });
  return post.targets[0];
}

/** Graph stub: counts by post id, comments by post id; tokens can be marked broken */
function graph(counts: Record<string, [number, number, number]>, comments: Record<string, unknown[]>, opts: { deniedPosts?: string[]; brokenToken?: string } = {}) {
  return vi.fn(async (input: string) => {
    const url = new URL(input);
    if (opts.brokenToken && url.searchParams.get('access_token')?.includes(opts.brokenToken)) {
      return json({ error: { message: 'Session has expired', code: 190, error_subcode: 463 } }, 400);
    }
    const ids = url.searchParams.get('ids');
    if (ids) {
      return json(
        Object.fromEntries(
          ids
            .split(',')
            .filter((id) => counts[id])
            .map((id) => {
              const [r, c, s] = counts[id];
              return [id, { id, reactions: { summary: { total_count: r } }, comments: { summary: { total_count: c } }, ...(s ? { shares: { count: s } } : {}) }];
            })
        )
      );
    }
    const postId = url.pathname.split('/').at(-2)!;
    if (opts.deniedPosts?.includes(postId)) return json({ error: { message: '(#10) Requires pages_read_user_content', code: 10 } }, 400);
    return json({ data: comments[postId] ?? [] });
  });
}

describe.skipIf(!process.env.RUN_DB_TESTS)('engagement sync', { timeout: 60_000 }, () => {
  beforeAll(async () => {
    userId = (await createTestUser()).user.id;
    // The sync builds a FacebookClient from the user's settings (never reaches Facebook: fetch is stubbed)
    await saveSettings(userId, { fbAppId: '111', fbAppSecret: 'fake-secret-engagement' });
  });
  afterAll(async () => {
    await cleanupTestUsers();
    await prisma.$disconnect();
  });

  it('stores counts and comments, and knows which comments still need a reply', async () => {
    const fb = `ES1_${uniq()}`;
    const p = await page(fb);
    const t = await published(p.id, `${fb}_POST`);
    vi.stubGlobal(
      'fetch',
      graph(
        { [`${fb}_POST`]: [38, 3, 4] },
        {
          [`${fb}_POST`]: [
            { id: `${fb}_C1`, message: 'Có workflow mẫu không?', created_time: '2026-09-30T08:00:00+0000', from: { id: 'U1', name: 'An' } },
            {
              id: `${fb}_C2`,
              message: 'Hay quá',
              created_time: '2026-09-30T07:00:00+0000',
              from: { id: 'U2', name: 'Bình' },
              comments: { data: [{ id: `${fb}_C2_R`, message: 'Cảm ơn bạn!', created_time: '2026-09-30T07:30:00+0000', from: { id: fb, name: `Page ${fb}` } }] },
            },
          ],
        }
      )
    );
    await runEngagementSync(now, { id: t.id });
    const saved = await prisma.postTarget.findUniqueOrThrow({ where: { id: t.id }, include: { comments: { orderBy: { commentedAt: 'asc' } } } });
    expect(saved).toMatchObject({ reactionCount: 38, commentCount: 3, shareCount: 4, unansweredCount: 1, commentsError: null });
    expect(saved.comments.map((c) => [c.fbCommentId, c.fromPage, c.pageReplied])).toEqual([
      [`${fb}_C2`, false, true],
      [`${fb}_C2_R`, true, false],
      [`${fb}_C1`, false, false],
    ]);
  });

  it('a reply made directly on Facebook, or a deleted comment, updates "cần trả lời" on the next sync', async () => {
    const fb = `ES2_${uniq()}`;
    const p = await page(fb);
    const t = await published(p.id, `${fb}_POST`);
    const c1 = { id: `${fb}_D1`, message: 'Giá bao nhiêu?', created_time: '2026-09-30T08:00:00+0000', from: { id: 'U1', name: 'An' } };
    const c2 = { id: `${fb}_D2`, message: 'Ship không?', created_time: '2026-09-30T08:05:00+0000', from: { id: 'U2', name: 'Bình' } };
    vi.stubGlobal('fetch', graph({ [`${fb}_POST`]: [1, 2, 0] }, { [`${fb}_POST`]: [c2, c1] }));
    await runEngagementSync(now, { id: t.id });
    expect((await prisma.postTarget.findUniqueOrThrow({ where: { id: t.id } })).unansweredCount).toBe(2);

    // Page answered D1 on Facebook; D2 was deleted
    const answered = { ...c1, comments: { data: [{ id: `${fb}_D1_R`, message: 'Inbox nhé', created_time: '2026-09-30T09:00:00+0000', from: { id: fb } }] } };
    vi.stubGlobal('fetch', graph({ [`${fb}_POST`]: [1, 2, 0] }, { [`${fb}_POST`]: [answered] }));
    await runEngagementSync(new Date(now.getTime() + 3600_000), { id: t.id });
    const saved = await prisma.postTarget.findUniqueOrThrow({ where: { id: t.id }, include: { comments: true } });
    expect(saved.unansweredCount).toBe(0);
    expect(saved.comments.map((c) => c.fbCommentId).sort()).toEqual([`${fb}_D1`, `${fb}_D1_R`]);
  });

  it('a thread with more replies than fetched keeps the Page reply and stays answered', async () => {
    const fb = `ES4_${uniq()}`;
    const p = await page(fb);
    const t = await published(p.id, `${fb}_POST`);
    // The Page answered in the app earlier (stored), then many viewers replied after it
    await prisma.postComment.create({ data: { targetId: t.id, fbCommentId: `${fb}_TOP`, message: 'Còn hàng không?', commentedAt: new Date('2026-09-29T08:00:00Z'), pageReplied: true } });
    await prisma.postComment.create({ data: { targetId: t.id, fbCommentId: `${fb}_APP_REPLY`, parentFbId: `${fb}_TOP`, message: 'Còn nhé', commentedAt: new Date('2026-09-29T08:10:00Z'), fromPage: true } });
    const viewerReplies = Array.from({ length: 25 }, (_, i) => ({ id: `${fb}_R${i}`, message: `+${i}`, created_time: '2026-09-30T08:00:00+0000', from: { id: `U${i}`, name: `U${i}` } }));
    vi.stubGlobal(
      'fetch',
      graph({ [`${fb}_POST`]: [1, 27, 0] }, {
        [`${fb}_POST`]: [{ id: `${fb}_TOP`, message: 'Còn hàng không?', created_time: '2026-09-29T08:00:00+0000', from: { id: 'U0', name: 'An' }, comments: { data: viewerReplies, paging: { next: 'https://graph.facebook.com/next' } } }],
      })
    );
    await runEngagementSync(now, { id: t.id });
    const saved = await prisma.postTarget.findUniqueOrThrow({ where: { id: t.id }, include: { comments: true } });
    expect(saved.unansweredCount).toBe(0);
    expect(saved.comments.find((c) => c.fbCommentId === `${fb}_TOP`)?.pageReplied).toBe(true);
    expect(saved.comments.some((c) => c.fbCommentId === `${fb}_APP_REPLY`)).toBe(true);
  });

  it('with more than 50 comments, older comments outside the fetched window keep their replies', async () => {
    const fb = `ES5_${uniq()}`;
    const p = await page(fb);
    const t = await published(p.id, `${fb}_POST`);
    await prisma.postComment.create({ data: { targetId: t.id, fbCommentId: `${fb}_OLD`, message: 'Cũ', commentedAt: new Date('2026-09-01T08:00:00Z'), pageReplied: true } });
    await prisma.postComment.create({ data: { targetId: t.id, fbCommentId: `${fb}_OLD_R`, parentFbId: `${fb}_OLD`, message: 'Trả lời cũ', commentedAt: new Date('2026-09-01T09:00:00Z'), fromPage: true } });
    const newer = Array.from({ length: 50 }, (_, i) => ({ id: `${fb}_N${i}`, message: `n${i}`, created_time: `2026-09-30T0${Math.floor(i / 10)}:${String(i % 10).padStart(2, '0')}:00+0000`, from: { id: `U${i}` } }));
    vi.stubGlobal('fetch', graph({ [`${fb}_POST`]: [0, 52, 0] }, { [`${fb}_POST`]: newer.reverse() }));
    await runEngagementSync(now, { id: t.id });
    const ids = (await prisma.postComment.findMany({ where: { targetId: t.id }, select: { fbCommentId: true } })).map((c) => c.fbCommentId);
    expect(ids).toContain(`${fb}_OLD`);
    expect(ids).toContain(`${fb}_OLD_R`);
    expect(ids).toHaveLength(52);
  });

  it('without the comment permission, counts still sync and the reason is kept', async () => {
    const fb = `ES3_${uniq()}`;
    const p = await page(fb, ['pages_manage_posts', 'pages_read_engagement', 'pages_show_list']);
    const t = await published(p.id, `${fb}_POST`);
    const fetch = graph({ [`${fb}_POST`]: [5, 2, 0] }, {});
    vi.stubGlobal('fetch', fetch);
    await runEngagementSync(now, { id: t.id });
    expect(await prisma.postTarget.findUniqueOrThrow({ where: { id: t.id } })).toMatchObject({ reactionCount: 5, commentCount: 2, commentsError: COMMENTS_NEED_RESYNC });
    // Comments were not even requested (scope known missing)
    expect(fetch.mock.calls.some((c) => new URL(String(c[0])).pathname.endsWith('/comments'))).toBe(false);

    // Scope recorded but Facebook still refuses: same message, counts kept
    await prisma.facebookPage.update({ where: { id: p.id }, data: { grantedScopes: READ } });
    vi.stubGlobal('fetch', graph({ [`${fb}_POST`]: [5, 2, 0] }, {}, { deniedPosts: [`${fb}_POST`] }));
    await runEngagementSync(now, { id: t.id });
    expect(await prisma.postTarget.findUniqueOrThrow({ where: { id: t.id } })).toMatchObject({ reactionCount: 5, commentsError: COMMENTS_NEED_RESYNC });
  });

  it('one Page with an expired token does not stop the others', async () => {
    const badFb = `ESBAD_${uniq()}`;
    const goodFb = `ESGOOD_${uniq()}`;
    const bad = await page(badFb);
    const good = await page(goodFb);
    const tb = await published(bad.id, `${badFb}_POST`);
    const tg = await published(good.id, `${goodFb}_POST`);
    vi.stubGlobal('fetch', graph({ [`${badFb}_POST`]: [9, 0, 0], [`${goodFb}_POST`]: [7, 0, 0] }, {}, { brokenToken: badFb }));
    await expect(runEngagementSync(now, { id: { in: [tb.id, tg.id] } })).resolves.toBeUndefined();
    expect((await prisma.postTarget.findUniqueOrThrow({ where: { id: tg.id } })).reactionCount).toBe(7);
    expect((await prisma.postTarget.findUniqueOrThrow({ where: { id: tb.id } })).reactionCount).toBeNull();
  });

  it('skips posts older than 30 days and Pages that cannot post', async () => {
    const oldFb = `ESOLD_${uniq()}`;
    const offFb = `ESOFF_${uniq()}`;
    const p = await page(oldFb);
    const old = await published(p.id, `${oldFb}_POST`, 45);
    const off = await page(offFb, READ, { tokenStatus: 'EXPIRED' });
    const t2 = await published(off.id, `${offFb}_POST`);
    const fetch = graph({ [`${oldFb}_POST`]: [1, 0, 0], [`${offFb}_POST`]: [1, 0, 0] }, {});
    vi.stubGlobal('fetch', fetch);
    await runEngagementSync(now, { id: { in: [old.id, t2.id] } });
    expect(fetch).not.toHaveBeenCalled();
  });
});
