import { describe, it, expect, afterAll, vi } from 'vitest';
import '../src/config';
import prisma from '../src/utils/prisma';
import { encrypt } from '../src/lib/crypto';
import { saveSettings } from '../src/lib/settings';
import { GeminiClient } from '../src/lib/clients/gemini';
import { draftReplies } from '../src/services/reply-drafts';
import { runEngagementSync } from '../src/services/engagement-sync';
import { cleanupTestUsers, createTestUser } from './helpers/users';

const ALL = ['pages_manage_posts', 'pages_read_engagement', 'pages_show_list', 'pages_read_user_content', 'pages_manage_engagement'];
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

async function setup(opts: { autoReply?: boolean; scopes?: string[]; geminiKey?: boolean } = {}) {
  const { user } = await createTestUser();
  await saveSettings(user.id, { fbAppId: '111', fbAppSecret: 'fake-secret-reply-drafts', ...(opts.geminiKey !== false && { geminiApiKey: 'AIzaFakeKeyReplyDrafts0000000000000000' }) });
  const tag = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const domain = await prisma.contentDomain.create({ data: { userId: user.id, name: `BVTV ${tag}`, voice: 'Gần gũi', replyInstructions: 'Xưng em, gọi anh chị.' } });
  const page = await prisma.facebookPage.create({
    data: { userId: user.id, pageId: `RD_${tag}`, pageName: 'Nhà nông', pageAccessToken: encrypt('EAAtokenreplydraftsxxxxxxxxxxxxxxxx'), tokenStatus: 'VALID', grantedScopes: opts.scopes ?? ALL, autoReply: opts.autoReply ?? true },
  });
  const post = await prisma.post.create({
    data: {
      userId: user.id,
      pageId: page.id,
      domainId: domain.id,
      caption: 'Lúa vàng lá: nhổ thử vài bụi xem rễ trước khi phun.',
      status: 'PUBLISHED',
      targets: { create: { pageId: page.id, status: 'PUBLISHED', fbPostId: `RD_POST_${tag}`, publishedAt: new Date() } },
    },
    include: { targets: true },
  });
  const target = post.targets[0];
  let n = 0;
  const base = Date.now() - 600_000;
  /** Comments in the order they were made: the AI sees them as c1, c2… */
  const comment = (message: string, extra: Record<string, unknown> = {}) =>
    prisma.postComment.create({ data: { targetId: target.id, fbCommentId: `RC_${tag}_${++n}`, authorName: `Khách ${n}`, message, commentedAt: new Date(base + n * 1000), ...extra } });
  const row = (id: string) => prisma.postComment.findUniqueOrThrow({ where: { id } });
  return { page, post, target, comment, row };
}

const fakeGemini = (replies: Array<Record<string, unknown>>) => vi.spyOn(GeminiClient.prototype, 'generateJson').mockResolvedValue({ replies } as never);

describe.skipIf(!process.env.RUN_DB_TESTS)('AI reply drafts', { timeout: 60_000 }, () => {
  afterAll(async () => {
    await cleanupTestUsers();
    await prisma.$disconnect();
  });

  it('drafts a reply for each comment that waits, in one AI call, and leaves alone what the AI says to skip', async () => {
    const { target, comment, row } = await setup();
    const price = await comment('Thuốc này giá bao nhiêu shop?');
    const tag = await comment('@Bình vào xem nè');
    const answered = await comment('Hay quá', { pageReplied: true });
    const handled = await comment('Spam', { handledAt: new Date() });
    const ours = await comment('Cảm ơn bà con', { fromPage: true });
    const reply = await comment('trả lời của khách', { parentFbId: price.fbCommentId });
    const gemini = fakeGemini([{ key: 'c1', reply: 'Dạ mời anh nhắn tin cho Page ạ.', skip: false }, { key: 'c2', reply: '', skip: true }]);

    expect(await draftReplies(target.id)).toBe(1);
    expect(gemini).toHaveBeenCalledTimes(1);
    const asked = gemini.mock.calls[0][0];
    expect(asked.prompt).toContain('Lúa vàng lá');
    expect(asked.prompt).toContain('"key":"c1","author":"Khách 1","message":"Thuốc này giá bao nhiêu shop?"');
    expect(asked.prompt).toContain('"key":"c2"');
    expect(asked.prompt).not.toContain('"key":"c3"'); // answered, handled, the Page's own and replies are not asked about
    expect(asked.systemInstruction).toContain('Page Facebook "Nhà nông"');
    expect(asked.systemInstruction).toContain('Cách trả lời:\nXưng em, gọi anh chị.');

    expect(await row(price.id)).toMatchObject({ draftReply: 'Dạ mời anh nhắn tin cho Page ạ.', draftCheckedAt: expect.any(Date) });
    expect(await row(tag.id)).toMatchObject({ draftReply: null, draftCheckedAt: expect.any(Date) });
    for (const untouched of [answered, handled, ours, reply]) expect(await row(untouched.id)).toMatchObject({ draftReply: null, draftCheckedAt: null });
  });

  it('never asks twice about the same comment; a new comment is asked about alone', async () => {
    const { target, comment, row } = await setup();
    await comment('Cho hỏi mua ở đâu?');
    const gemini = fakeGemini([{ key: 'c1', reply: 'Dạ mời anh nhắn tin ạ.', skip: false }]);
    await draftReplies(target.id);
    expect(await draftReplies(target.id)).toBe(0);
    expect(gemini).toHaveBeenCalledTimes(1);
    const later = await comment('Còn hàng không?');
    expect(await draftReplies(target.id)).toBe(1);
    expect(gemini).toHaveBeenCalledTimes(2);
    expect(gemini.mock.calls[1][0].prompt).toContain('"key":"c1","author":"Khách 2","message":"Còn hàng không?"');
    expect(gemini.mock.calls[1][0].prompt).not.toContain('mua ở đâu');
    expect((await row(later.id)).draftReply).toBe('Dạ mời anh nhắn tin ạ.');
  });

  it('asks about at most 20 comments at a time, oldest first', async () => {
    const { target, comment } = await setup();
    for (let i = 0; i < 22; i++) await comment(`Câu hỏi ${i + 1}`);
    const gemini = fakeGemini([]);
    await draftReplies(target.id);
    const first = JSON.parse(gemini.mock.calls[0][0].prompt.split('Bình luận (JSON):\n')[1]);
    expect(first).toHaveLength(20);
    expect(first[0].message).toBe('Câu hỏi 1');
    await draftReplies(target.id);
    expect(JSON.parse(gemini.mock.calls[1][0].prompt.split('Bình luận (JSON):\n')[1]).map((c: { message: string }) => c.message)).toEqual(['Câu hỏi 21', 'Câu hỏi 22']);
  });

  it('does nothing when the Page has it off, the post opted out, the Page cannot answer, or there is no Gemini key', async () => {
    const gemini = fakeGemini([{ key: 'c1', reply: 'x', skip: false }]);
    const off = await setup({ autoReply: false });
    const optedOut = await setup();
    await prisma.post.update({ where: { id: optedOut.post.id }, data: { autoReplyOff: true } });
    const readOnly = await setup({ scopes: ALL.filter((s) => s !== 'pages_manage_engagement') });
    const noKey = await setup({ geminiKey: false });
    for (const s of [off, optedOut, readOnly, noKey]) {
      const c = await s.comment('Giá bao nhiêu?');
      expect(await draftReplies(s.target.id)).toBe(0);
      expect(await s.row(c.id)).toMatchObject({ draftReply: null, draftCheckedAt: null });
    }
    expect(gemini).not.toHaveBeenCalled();
  });

  it('a comment with no text is not sent to the AI', async () => {
    const { target, comment, row } = await setup();
    const sticker = await comment('   ');
    const gemini = fakeGemini([]);
    expect(await draftReplies(target.id)).toBe(0);
    expect(gemini).not.toHaveBeenCalled();
    expect(await row(sticker.id)).toMatchObject({ draftReply: null, draftCheckedAt: expect.any(Date) });
  });

  it('a failed AI call marks nothing: the next sync asks again', async () => {
    const { target, comment, row } = await setup();
    const c = await comment('Giá bao nhiêu?');
    const gemini = vi.spyOn(GeminiClient.prototype, 'generateJson').mockRejectedValueOnce(new Error('quota exceeded'));
    await expect(draftReplies(target.id)).rejects.toThrow('quota exceeded');
    expect(await row(c.id)).toMatchObject({ draftReply: null, draftCheckedAt: null });
    gemini.mockResolvedValue({ replies: [{ key: 'c1', reply: 'Dạ mời anh nhắn tin ạ.', skip: false }] } as never);
    expect(await draftReplies(target.id)).toBe(1);
  });

  it('the sync drafts replies for a Page that has it on, and a failing AI never fails the sync', async () => {
    const { target } = await setup();
    const fbPostId = target.fbPostId!;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL) => {
        const url = new URL(String(input));
        if (url.searchParams.get('ids')) return json({ [fbPostId]: { id: fbPostId, reactions: { summary: { total_count: 2 } }, comments: { summary: { total_count: 1 } } } });
        return json({ data: [{ id: `${fbPostId}_c1`, message: 'Giá bao nhiêu shop?', created_time: new Date().toISOString(), from: { id: 'U1', name: 'Bình' } }] });
      })
    );
    const gemini = vi.spyOn(GeminiClient.prototype, 'generateJson').mockRejectedValueOnce(new Error('AI down'));
    await runEngagementSync(new Date(), { id: target.id });
    // the comment and the counts are stored although the AI failed
    expect(await prisma.postTarget.findUniqueOrThrow({ where: { id: target.id } })).toMatchObject({ commentCount: 1, unansweredCount: 1 });
    gemini.mockResolvedValue({ replies: [{ key: 'c1', reply: 'Dạ mời anh Bình nhắn tin cho Page ạ.', skip: false }] } as never);
    await runEngagementSync(new Date(), { id: target.id });
    expect(await prisma.postComment.findUniqueOrThrow({ where: { fbCommentId: `${fbPostId}_c1` } })).toMatchObject({ draftReply: 'Dạ mời anh Bình nhắn tin cho Page ạ.' });
  });
});
