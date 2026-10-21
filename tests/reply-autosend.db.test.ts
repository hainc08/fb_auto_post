import { describe, it, expect, afterAll, vi } from 'vitest';
import '../src/config';
import prisma from '../src/utils/prisma';
import { encrypt } from '../src/lib/crypto';
import { saveSettings } from '../src/lib/settings';
import { FacebookApiError, FacebookClient } from '../src/lib/clients/facebook';
import { autoSendReplies } from '../src/services/reply-autosend';
import { cleanupTestUsers, createTestUser } from './helpers/users';

const ALL = ['pages_manage_posts', 'pages_read_engagement', 'pages_show_list', 'pages_read_user_content', 'pages_manage_engagement'];

type PageOpts = { autoReply?: boolean; autoSend?: boolean; perHour?: number; scopes?: string[]; keywords?: string | null };

async function setup(opts: PageOpts = {}) {
  const { user } = await createTestUser();
  await saveSettings(user.id, { fbAppId: '111', fbAppSecret: 'fake-secret-autosend' });
  const tag = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const domain = await prisma.contentDomain.create({ data: { userId: user.id, name: `BVTV ${tag}`, replyHoldKeywords: opts.keywords ?? null } });
  const page = await prisma.facebookPage.create({
    data: {
      userId: user.id,
      pageId: `AS_${tag}`,
      pageName: 'Nhà nông',
      pageAccessToken: encrypt('EAAtokenautosendxxxxxxxxxxxxxxxxxxx'),
      tokenStatus: 'VALID',
      grantedScopes: opts.scopes ?? ALL,
      autoReply: opts.autoReply ?? true,
      autoSend: opts.autoSend ?? true,
      autoSendPerHour: opts.perHour ?? 10,
      autoSendSince: new Date(Date.now() - 60_000),
    },
  });
  let posts = 0;
  let n = 0;
  const base = Date.now() - 600_000;
  /** A published post of this Page; returns its target and a way to add drafted comments to it */
  const newPost = async () => {
    const post = await prisma.post.create({
      data: {
        userId: user.id,
        pageId: page.id,
        domainId: domain.id,
        caption: 'Lúa vàng lá',
        status: 'PUBLISHED',
        targets: { create: { pageId: page.id, status: 'PUBLISHED', fbPostId: `AS_POST_${tag}_${++posts}`, publishedAt: new Date() } },
      },
      include: { targets: true },
    });
    const target = post.targets[0];
    const comment = (message: string, extra: Record<string, unknown> = {}) =>
      prisma.postComment.create({
        data: { targetId: target.id, fbCommentId: `AC_${tag}_${++n}`, authorName: `Khách ${n}`, message, commentedAt: new Date(base + n * 1000), draftReply: `Dạ trả lời ${n}`, draftCheckedAt: new Date(), ...extra },
      });
    return { post, target, comment };
  };
  const row = (id: string) => prisma.postComment.findUniqueOrThrow({ where: { id } });
  return { page, newPost, row, ...(await newPost()) };
}

let replies = 0;
const fakeFacebook = () => vi.spyOn(FacebookClient.prototype, 'replyToComment').mockImplementation(async () => ({ id: `AS_REPLY_${Date.now()}_${++replies}` }));

describe.skipIf(!process.env.RUN_DB_TESTS)('Auto-send reply drafts', { timeout: 60_000 }, () => {
  afterAll(async () => {
    await cleanupTestUsers();
    await prisma.$disconnect();
  });

  it('sends the drafts oldest first and records them as answered and sent on their own', async () => {
    const { target, comment, row } = await setup();
    const first = await comment('Lúa nhà em bị vàng lá');
    const second = await comment('Cảm ơn shop');
    const fb = fakeFacebook();

    expect(await autoSendReplies(target.id)).toBe(2);
    expect(fb.mock.calls.map((c) => [c[0], c[2]])).toEqual([
      [first.fbCommentId, first.draftReply],
      [second.fbCommentId, second.draftReply],
    ]);
    for (const c of [first, second]) expect(await row(c.id)).toMatchObject({ pageReplied: true, draftReply: null, autoSentAt: expect.any(Date), heldReason: null });
    const stored = await prisma.postComment.findMany({ where: { targetId: target.id, fromPage: true } });
    expect(stored.map((r) => r.parentFbId).sort()).toEqual([first.fbCommentId, second.fbCommentId].sort());
    expect((await prisma.postTarget.findUniqueOrThrow({ where: { id: target.id } })).unansweredCount).toBe(0);
  });

  it('holds a comment with a keyword, a link or a phone number: its draft waits for the member', async () => {
    const { target, comment, row } = await setup();
    const price = await comment('Thuốc này giá bao nhiêu?');
    const link = await comment('xem https://spam.example');
    const phone = await comment('gọi 0912345678');
    const fine = await comment('Hay quá');
    const fb = fakeFacebook();

    expect(await autoSendReplies(target.id)).toBe(1);
    expect(fb).toHaveBeenCalledTimes(1);
    expect(await row(price.id)).toMatchObject({ heldReason: 'Có từ khoá "giá"', draftReply: price.draftReply, autoSentAt: null, pageReplied: false });
    expect(await row(link.id)).toMatchObject({ heldReason: 'Có đường link', draftReply: link.draftReply });
    expect(await row(phone.id)).toMatchObject({ heldReason: 'Có số điện thoại', draftReply: phone.draftReply });
    expect(await row(fine.id)).toMatchObject({ pageReplied: true });

    // held stays held at the next sync
    expect(await autoSendReplies(target.id)).toBe(0);
    expect(fb).toHaveBeenCalledTimes(1);
  });

  it("uses the domain's own keywords instead of the built-in list", async () => {
    const { target, comment, row } = await setup({ keywords: 'ship, còn hàng' });
    const price = await comment('giá bao nhiêu');
    const ship = await comment('Có ship về Long An không');
    fakeFacebook();
    expect(await autoSendReplies(target.id)).toBe(1);
    expect(await row(price.id)).toMatchObject({ pageReplied: true });
    expect(await row(ship.id)).toMatchObject({ heldReason: 'Có từ khoá "ship"' });
  });

  it('sends at most the hourly allowance per Page, across its posts; replies older than an hour do not count', async () => {
    const { target, comment, newPost, row } = await setup({ perHour: 3 });
    const old = await comment('trả lời từ trước', { draftReply: null, pageReplied: true, autoSentAt: new Date(Date.now() - 2 * 3_600_000) });
    const other = await newPost();
    await other.comment('bài khác 1');
    await other.comment('bài khác 2');
    expect(old.autoSentAt).not.toBeNull();
    const fb = fakeFacebook();
    expect(await autoSendReplies(other.target.id)).toBe(2);

    const a = await comment('một');
    const b = await comment('hai');
    expect(await autoSendReplies(target.id)).toBe(1); // 2 of 3 used by the other post
    expect(await row(a.id)).toMatchObject({ pageReplied: true });
    expect(await row(b.id)).toMatchObject({ pageReplied: false, draftReply: b.draftReply, heldReason: null });
    expect(fb).toHaveBeenCalledTimes(3);

    // an hour later there is room again
    expect(await autoSendReplies(target.id, new Date(Date.now() + 3_700_000))).toBe(1);
    expect(await row(b.id)).toMatchObject({ pageReplied: true });
  });

  it('leaves alone the drafts written before it was turned on', async () => {
    const { target, comment, row } = await setup();
    const before = await comment('cũ', { draftCheckedAt: new Date(Date.now() - 3_600_000) });
    const after = await comment('mới');
    fakeFacebook();
    expect(await autoSendReplies(target.id)).toBe(1);
    expect(await row(before.id)).toMatchObject({ draftReply: before.draftReply, pageReplied: false, heldReason: null });
    expect(await row(after.id)).toMatchObject({ pageReplied: true });
  });

  it('does nothing when the Page has it off, AI drafts off, the post opted out, or the Page cannot answer', async () => {
    const fb = fakeFacebook();
    const sendOff = await setup({ autoSend: false });
    const draftsOff = await setup({ autoReply: false });
    const optedOut = await setup();
    await prisma.post.update({ where: { id: optedOut.post.id }, data: { autoReplyOff: true } });
    const readOnly = await setup({ scopes: ALL.filter((s) => s !== 'pages_manage_engagement') });
    for (const s of [sendOff, draftsOff, optedOut, readOnly]) {
      const c = await s.comment('Hay quá');
      expect(await autoSendReplies(s.target.id)).toBe(0);
      expect(await s.row(c.id)).toMatchObject({ draftReply: c.draftReply, autoSentAt: null, heldReason: null });
    }
    expect(fb).not.toHaveBeenCalled();
  });

  it('a draft Facebook refused goes back to the member, is not counted, and stops the run', async () => {
    const { target, comment, row } = await setup();
    const refused = await comment('một');
    const next = await comment('hai');
    const fb = vi.spyOn(FacebookClient.prototype, 'replyToComment').mockRejectedValue(new FacebookApiError('Bình luận đã bị xoá', 100));

    expect(await autoSendReplies(target.id)).toBe(0);
    expect(fb).toHaveBeenCalledTimes(1);
    expect(await row(refused.id)).toMatchObject({ draftReply: refused.draftReply, autoSentAt: null, pageReplied: false, heldReason: expect.stringContaining('Tự gửi không được') });
    expect(await row(next.id)).toMatchObject({ draftReply: next.draftReply, heldReason: null });
    // never tried again on its own
    fakeFacebook();
    expect(await autoSendReplies(target.id)).toBe(1);
    expect(await row(refused.id)).toMatchObject({ pageReplied: false });
  });

  it('a draft Facebook gave no clear answer for is held and never sent again on its own', async () => {
    const { target, comment, row } = await setup({ perHour: 1 });
    const unclear = await comment('một');
    vi.spyOn(FacebookClient.prototype, 'replyToComment').mockRejectedValue(new Error('socket hang up'));

    expect(await autoSendReplies(target.id)).toBe(0);
    expect(await row(unclear.id)).toMatchObject({ draftReply: unclear.draftReply, autoSentAt: expect.any(Date), heldReason: expect.stringContaining('Không chắc') });
    const fb = fakeFacebook();
    fb.mockClear(); // the same spy as above: forget the failed call
    await comment('hai');
    // it may be live, so it still counts against the hour
    expect(await autoSendReplies(target.id)).toBe(0);
    expect(fb).not.toHaveBeenCalled();
  });
});
