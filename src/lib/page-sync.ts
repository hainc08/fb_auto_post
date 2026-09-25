import { z } from 'zod';
import prisma from '../utils/prisma';
import { decrypt, encrypt } from './crypto';
import { FacebookClient } from './clients/facebook';
import { getSettings } from './settings';
import { blockMessage, blockReason, classifyInspectError, classifyToken, TokenCheck } from './page-health';

/**
 * "Đồng bộ Page": one flow to (re)connect Pages with the current Facebook App.
 *
 *   preview(userToken) → what would change, nothing written
 *   apply(refs, disconnect) → write it
 *
 * Page tokens never reach the browser: each Page in the preview carries an
 * encrypted `ref` (token + check result) that the client sends back to apply.
 */

export type SyncAction = 'update' | 'reconnect' | 'add' | 'disconnect';

export interface SyncItem {
  action: SyncAction;
  pageId: string; // Facebook Page ID
  pageName: string;
  category?: string;
  picture?: string;
  /** DB id, for Pages already known */
  pageDbId?: string;
  /** Present for update / reconnect / add */
  ref?: string;
  /** Token health of the new token (update / reconnect / add) */
  tokenStatus?: TokenCheck['tokenStatus'];
  problem?: string | null;
  /** Pre-ticked in the preview */
  selected: boolean;
}

export interface SyncPreview {
  appId: string;
  items: SyncItem[];
  counts: Record<SyncAction, number>;
}

/** A preview is applied within this window, or re-done (tokens may have changed). */
const REF_TTL_MS = 30 * 60_000;

const refSchema = z.object({
  id: z.string(),
  name: z.string(),
  category: z.string().optional(),
  picture: z.string().optional(),
  token: z.string(),
  check: z.object({
    tokenStatus: z.enum(['UNCHECKED', 'VALID', 'OTHER_APP', 'EXPIRED', 'REVOKED', 'MISSING_PERMISSIONS', 'ERROR']),
    tokenAppId: z.string().nullable(),
    tokenExpiresAt: z.string().nullable(),
    missingScopes: z.array(z.string()),
    tokenError: z.string().nullable(),
  }),
  userId: z.string(),
  iat: z.number(),
});
type RefData = z.infer<typeof refSchema>;

export class SyncError extends Error {
  constructor(
    readonly step: 'exchange' | 'list' | 'apply',
    message: string,
    readonly errorCode?: string
  ) {
    super(message);
    this.name = 'SyncError';
  }
}

const STEP_LABEL = { exchange: 'Đổi sang token dài hạn', list: 'Lấy danh sách Page', apply: 'Áp dụng' } as const;
export const syncErrorMessage = (e: SyncError) => `${STEP_LABEL[e.step]} thất bại: ${e.message}`;

export async function previewSync(userId: string, userToken: string): Promise<SyncPreview> {
  const settings = await getSettings(userId);
  const fb = new FacebookClient({ appId: settings.fbAppId, appSecret: settings.fbAppSecret, graphVersion: settings.fbGraphVersion }, [userToken]);

  let longToken: string;
  try {
    // Long-lived user token ⇒ Page tokens derived from it do not expire
    longToken = await fb.exchangeLongLivedUserToken(userToken);
  } catch (error) {
    const e = error as Error & { errorCode?: string };
    throw new SyncError('exchange', e.message, e.errorCode);
  }

  let fbPages;
  try {
    fbPages = await fb.listPages(longToken);
  } catch (error) {
    const e = error as Error & { errorCode?: string };
    throw new SyncError('list', e.message, e.errorCode);
  }

  // Check each new Page token against the current app, a few at a time
  const checks: TokenCheck[] = [];
  for (let i = 0; i < fbPages.length; i += 4) {
    checks.push(
      ...(await Promise.all(
        fbPages.slice(i, i + 4).map((p) =>
          fb.inspectOwnToken(p.access_token).then(
            (info) => classifyToken(info, settings.fbAppId),
            (error) => classifyInspectError(error)
          )
        )
      ))
    );
  }

  const known = await prisma.facebookPage.findMany({ where: { userId } });
  const byPageId = new Map(known.map((p) => [p.pageId, p]));
  const seen = new Set<string>();
  const iat = Date.now();

  const items: SyncItem[] = fbPages.map((p, i) => {
    const db = byPageId.get(p.id);
    seen.add(p.id);
    const check = checks[i];
    const ref: RefData = {
      id: p.id,
      name: p.name,
      category: p.category,
      picture: p.picture,
      token: p.access_token,
      check: { ...check, tokenExpiresAt: check.tokenExpiresAt?.toISOString() ?? null },
      userId,
      iat,
    };
    const health = { isActive: true, tokenStatus: check.tokenStatus, tokenAppId: check.tokenAppId, missingScopes: check.missingScopes };
    const reason = blockReason(health, settings.fbAppId);
    const action: SyncAction = !db ? 'add' : db.isActive ? 'update' : 'reconnect';
    return {
      action,
      pageId: p.id,
      pageName: p.name,
      category: p.category,
      picture: p.picture,
      pageDbId: db?.id,
      ref: encrypt(JSON.stringify(ref)),
      tokenStatus: check.tokenStatus,
      problem: reason ? blockMessage(reason, health) : check.tokenStatus === 'ERROR' ? check.tokenError : null,
      // A Page the user disconnected on purpose is not reconnected unless ticked
      selected: action !== 'reconnect',
    };
  });

  // Connected Pages this token does not cover any more
  for (const db of known) {
    if (!db.isActive || seen.has(db.pageId)) continue;
    items.push({ action: 'disconnect', pageId: db.pageId, pageName: db.pageName, category: db.pageCategory ?? undefined, picture: db.pageAvatar ?? undefined, pageDbId: db.id, selected: true });
  }

  const order: Record<SyncAction, number> = { update: 0, add: 1, reconnect: 2, disconnect: 3 };
  items.sort((a, b) => order[a.action] - order[b.action] || a.pageName.localeCompare(b.pageName, 'vi'));
  const counts = { update: 0, reconnect: 0, add: 0, disconnect: 0 };
  for (const item of items) counts[item.action]++;
  return { appId: settings.fbAppId, items, counts };
}

export interface ApplyResult {
  connected: number;
  disconnected: number;
}

/** Store the ticked Pages' new tokens and disconnect the ticked lost Pages. */
export async function applySync(userId: string, refs: string[], disconnectIds: string[]): Promise<ApplyResult> {
  const pages = refs.map((ref) => {
    let data: RefData;
    try {
      data = refSchema.parse(JSON.parse(decrypt(ref)));
    } catch {
      throw new SyncError('apply', 'Dữ liệu xem trước không hợp lệ. Hãy đồng bộ lại.');
    }
    if (data.userId !== userId) throw new SyncError('apply', 'Dữ liệu xem trước không thuộc tài khoản này.');
    if (Date.now() - data.iat > REF_TTL_MS) throw new SyncError('apply', 'Bản xem trước đã quá 30 phút. Hãy đồng bộ lại.');
    return data;
  });

  const now = new Date();
  const results = await prisma.$transaction([
    ...pages.map((p) => {
      const fields = {
        pageName: p.name,
        pageCategory: p.category,
        ...(p.picture && { pageAvatar: p.picture }),
        pageAccessToken: encrypt(p.token),
        isActive: true,
        tokenStatus: p.check.tokenStatus,
        tokenAppId: p.check.tokenAppId,
        tokenExpiresAt: p.check.tokenExpiresAt ? new Date(p.check.tokenExpiresAt) : null,
        missingScopes: p.check.missingScopes,
        tokenError: p.check.tokenError,
        tokenCheckedAt: now,
      };
      return prisma.facebookPage.upsert({
        where: { userId_pageId: { userId, pageId: p.id } },
        create: { userId, pageId: p.id, ...fields },
        update: fields,
      });
    }),
    // Never delete: a Page's posts and history cascade with it
    prisma.facebookPage.updateMany({ where: { userId, id: { in: disconnectIds }, isActive: true }, data: { isActive: false } }),
  ]);

  const { count: disconnected } = results[results.length - 1] as { count: number };
  return { connected: pages.length, disconnected };
}
