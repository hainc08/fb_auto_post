import { describe, it, expect, afterAll, vi } from 'vitest';
import '../src/config';
import prisma from '../src/utils/prisma';
import { encrypt } from '../src/lib/crypto';
import { FacebookClient } from '../src/lib/clients/facebook';
import { postFirstComment } from '../src/services/first-comment';
import { cleanupTestUsers, createTestUser } from './helpers/users';

const TOKEN = 'EAAfaketokenfirstcommentdbxxxxxxxxxx';

async function setup() {
  const { user } = await createTestUser();
  const tag = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const page = await prisma.facebookPage.create({
    data: { userId: user.id, pageId: `FC_${tag}`, pageName: 'Nhà nông', pageAccessToken: encrypt(TOKEN), tokenStatus: 'VALID' },
  });
  const post = await prisma.post.create({
    data: { userId: user.id, pageId: page.id, caption: 'x', status: 'PUBLISHED', targets: { create: { pageId: page.id, status: 'PUBLISHED', fbPostId: `FC_POST_${tag}`, publishedAt: new Date() } } },
    include: { targets: true },
  });
  return { target: post.targets[0] };
}

describe.skipIf(!process.env.RUN_DB_TESTS)('first comment service', { timeout: 60_000 }, () => {
  afterAll(async () => {
    await cleanupTestUsers();
    await prisma.$disconnect();
  });

  it('posts the template once, records the id and the text posted', async () => {
    const { target } = await setup();
    const spy = vi.spyOn(FacebookClient.prototype, 'createComment').mockResolvedValue({ id: 'FC_POST_1_C_1' });
    const facebook = new FacebookClient({ appId: '1', appSecret: 'x', graphVersion: 'v23.0' }, [TOKEN]);
    expect(await postFirstComment(target.id, facebook, TOKEN, '  Link: https://example.com/a  ')).toBe('posted');
    expect(spy).toHaveBeenCalledWith(target.fbPostId, TOKEN, 'Link: https://example.com/a');
    expect(await prisma.postTarget.findUniqueOrThrow({ where: { id: target.id } })).toMatchObject({
      firstCommentId: 'FC_POST_1_C_1',
      firstCommentText: 'Link: https://example.com/a',
      firstCommentError: null,
      status: 'PUBLISHED',
    });
    // a second call (retry of the job) never posts again
    expect(await postFirstComment(target.id, facebook, TOKEN, 'Link: https://example.com/a')).toBe('already');
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('a blank or missing template posts nothing and records nothing', async () => {
    const { target } = await setup();
    const spy = vi.spyOn(FacebookClient.prototype, 'createComment').mockResolvedValue({ id: 'never' });
    const facebook = new FacebookClient({ appId: '1', appSecret: 'x', graphVersion: 'v23.0' }, [TOKEN]);
    expect(await postFirstComment(target.id, facebook, TOKEN, '   ')).toBe('skipped');
    expect(await postFirstComment(target.id, facebook, TOKEN, null)).toBe('skipped');
    expect(spy).not.toHaveBeenCalled();
    expect(await prisma.postTarget.findUniqueOrThrow({ where: { id: target.id } })).toMatchObject({ firstCommentId: null, firstCommentText: null, firstCommentError: null });
  });

  it('a refused comment is recorded and the target stays published', async () => {
    const { target } = await setup();
    vi.spyOn(FacebookClient.prototype, 'createComment').mockRejectedValue(new Error('Token thiếu quyền cần thiết (pages_manage_engagement).'));
    const facebook = new FacebookClient({ appId: '1', appSecret: 'x', graphVersion: 'v23.0' }, [TOKEN]);
    expect(await postFirstComment(target.id, facebook, TOKEN, 'Link')).toBe('failed');
    const row = await prisma.postTarget.findUniqueOrThrow({ where: { id: target.id } });
    expect(row).toMatchObject({ status: 'PUBLISHED', firstCommentId: null, firstCommentText: 'Link' });
    expect(row.firstCommentError).toMatch(/pages_manage_engagement/);
  });
});
