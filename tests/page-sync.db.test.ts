import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import '../src/config'; // loads .env (DATABASE_URL)
import prisma from '../src/utils/prisma';
import { encrypt } from '../src/lib/crypto';
import { getSettings } from '../src/lib/settings';
import { applySync, previewSync, SyncError } from '../src/lib/page-sync';

/**
 * "Đồng bộ Page" on the real MariaDB, Graph API mocked.
 *   RUN_DB_TESTS=1 npx vitest run tests/page-sync.db.test.ts
 * Stop any dev server on the same DB first.
 */
const P = { kept: 'SYNC_T_KEPT', lost: 'SYNC_T_LOST', back: 'SYNC_T_BACK', fresh: 'SYNC_T_NEW' };
let userId: string;
let appId: string;
const ids: Record<string, string> = {};

function mockGraph() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL) => {
      const url = new URL(String(input));
      const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
      if (url.pathname.endsWith('/oauth/access_token')) return json({ access_token: 'EAAlonglivedusertoken000000000000' });
      if (url.pathname.endsWith('/me/accounts')) {
        return json({
          data: [
            { id: P.kept, name: 'Trang giữ', category: 'Education', access_token: 'EAAnewtoken_kept_0000000000000' },
            { id: P.back, name: 'Trang từng ngắt', access_token: 'EAAnewtoken_back_0000000000000' },
            { id: P.fresh, name: 'Trang mới', access_token: 'EAAnewtoken_new_00000000000000' },
          ],
        });
      }
      if (url.pathname.endsWith('/debug_token')) {
        const token = url.searchParams.get('input_token')!;
        const scopes = token.includes('_new_') ? ['pages_show_list'] : ['pages_manage_posts', 'pages_read_engagement', 'pages_show_list'];
        return json({ data: { is_valid: true, type: 'PAGE', app_id: appId, scopes } });
      }
      return new Response(JSON.stringify({ error: { message: `unexpected ${url.pathname}`, code: 100 } }), { status: 400 });
    })
  );
}

describe.skipIf(!process.env.RUN_DB_TESTS)('Đồng bộ Page', { timeout: 30_000 }, () => {
  beforeAll(async () => {
    const user = (await prisma.user.findFirst()) ?? (await prisma.user.create({ data: { email: 'sync@test.local', name: 'Sync' } }));
    userId = user.id;
    appId = (await getSettings(userId)).fbAppId || '999';
    await prisma.facebookPage.deleteMany({ where: { pageId: { in: Object.values(P) } } });
    const make = (pageId: string, pageName: string, isActive: boolean) =>
      prisma.facebookPage.create({
        data: { userId, pageId, pageName, isActive, pageAccessToken: encrypt('EAAoldtoken00000000000000'), tokenStatus: 'OTHER_APP', tokenAppId: '12345' },
      });
    ids.kept = (await make(P.kept, 'Trang giữ (tên cũ)', true)).id;
    ids.lost = (await make(P.lost, 'Trang mất quyền', true)).id;
    ids.back = (await make(P.back, 'Trang từng ngắt', false)).id;
  });

  // vitest.config unstubs globals after every test
  beforeEach(mockGraph);

  afterAll(async () => {
    await prisma.facebookPage.deleteMany({ where: { pageId: { in: Object.values(P) } } });
    vi.unstubAllGlobals();
    await prisma.$disconnect();
  });

  it('previews update / add / reconnect / disconnect without writing anything', async () => {
    const preview = await previewSync(userId, 'EAAshortlivedusertoken00000000');
    const mine = preview.items.filter((i) => Object.values(P).includes(i.pageId));
    const by = Object.fromEntries(mine.map((i) => [i.pageId, i]));

    expect(by[P.kept]).toMatchObject({ action: 'update', selected: true, tokenStatus: 'VALID', problem: null, pageDbId: ids.kept });
    expect(by[P.fresh]).toMatchObject({ action: 'add', selected: true, tokenStatus: 'MISSING_PERMISSIONS' });
    expect(by[P.fresh].problem).toMatch(/pages_manage_posts/);
    expect(by[P.back]).toMatchObject({ action: 'reconnect', selected: false }); // disconnected on purpose
    expect(by[P.lost]).toMatchObject({ action: 'disconnect', selected: true, pageDbId: ids.lost });
    expect(by[P.lost].ref).toBeUndefined();
    // Page tokens never travel in clear text
    expect(JSON.stringify(preview)).not.toMatch(/EAAnewtoken/);

    const untouched = await prisma.facebookPage.findUniqueOrThrow({ where: { id: ids.kept } });
    expect(untouched).toMatchObject({ pageName: 'Trang giữ (tên cũ)', tokenStatus: 'OTHER_APP' });
  });

  it('applies the ticked changes: new tokens on the current app, lost Page disconnected, nothing deleted', async () => {
    const preview = await previewSync(userId, 'EAAshortlivedusertoken00000000');
    const pick = (pageId: string) => preview.items.find((i) => i.pageId === pageId)!;
    const result = await applySync(userId, [pick(P.kept).ref!, pick(P.fresh).ref!], [ids.lost]);
    expect(result).toEqual({ connected: 2, disconnected: 1 });

    const rows = await prisma.facebookPage.findMany({ where: { pageId: { in: Object.values(P) } } });
    const by = Object.fromEntries(rows.map((r) => [r.pageId, r]));
    expect(by[P.kept]).toMatchObject({ isActive: true, pageName: 'Trang giữ', tokenStatus: 'VALID', tokenAppId: appId });
    expect(by[P.kept].tokenCheckedAt).not.toBeNull();
    expect(by[P.fresh]).toMatchObject({ isActive: true, tokenStatus: 'MISSING_PERMISSIONS' });
    expect(by[P.lost].isActive).toBe(false); // kept, only disconnected
    expect(by[P.back].isActive).toBe(false); // not ticked → stays disconnected
    expect(rows).toHaveLength(4);
  });

  it('rejects a tampered or foreign preview', async () => {
    await expect(applySync(userId, ['not-a-ref'], [])).rejects.toBeInstanceOf(SyncError);
    const preview = await previewSync(userId, 'EAAshortlivedusertoken00000000');
    const ref = preview.items.find((i) => i.pageId === P.kept)!.ref!;
    await expect(applySync('someone-else', [ref], [])).rejects.toThrow(/không thuộc tài khoản/);
  });
});
