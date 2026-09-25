import { FacebookPage, Prisma, TokenStatus } from '@prisma/client';
import prisma from '../utils/prisma';
import { logger } from '../utils/logger';
import { FacebookApiError, FacebookClient, TokenDebugInfo } from './clients/facebook';
import { getSettings, revealSecret } from './settings';

/**
 * Health of each Page's access token.
 *
 * A Page token belongs to the Facebook App that issued it. After the App ID in
 * Settings changes, Pages still holding the old app's tokens keep publishing
 * through that app (e.g. visible to admins only while it is in Development),
 * so they are not postable until re-synced with the current app.
 */

export interface TokenCheck {
  tokenStatus: TokenStatus;
  tokenAppId: string | null;
  tokenExpiresAt: Date | null;
  missingScopes: string[];
  tokenError: string | null;
}

/** Classify one token inspection against the App ID currently configured. */
export function classifyToken(info: TokenDebugInfo, currentAppId: string): TokenCheck {
  const base = {
    tokenAppId: info.appId ?? null,
    tokenExpiresAt: info.expiresAt ? new Date(info.expiresAt) : null,
    missingScopes: info.missingScopes,
    tokenError: null,
  };
  if (!info.isValid) return { ...base, tokenStatus: 'REVOKED', tokenError: info.error ?? 'Token không hợp lệ.' };
  if (info.type !== 'PAGE') {
    return { ...base, tokenStatus: 'ERROR', tokenError: `Token loại ${info.type}, cần Page Access Token.` };
  }
  if (currentAppId && info.appId && info.appId !== currentAppId) return { ...base, tokenStatus: 'OTHER_APP' };
  if (info.missingScopes.length) return { ...base, tokenStatus: 'MISSING_PERMISSIONS' };
  return { ...base, tokenStatus: 'VALID' };
}

/** Graph refused to inspect the token at all (expired, revoked, network…). */
export function classifyInspectError(error: unknown): TokenCheck {
  const empty = { tokenAppId: null, tokenExpiresAt: null, missingScopes: [] };
  if (error instanceof FacebookApiError && error.code === 190) {
    // 463 = expired; 460 = password changed; others = revoked / invalid
    return { ...empty, tokenStatus: error.subcode === 463 ? 'EXPIRED' : 'REVOKED', tokenError: error.message };
  }
  return { ...empty, tokenStatus: 'ERROR', tokenError: (error as Error)?.message ?? String(error) };
}

export async function inspectPageToken(fb: FacebookClient, page: Pick<FacebookPage, 'pageAccessToken'>, currentAppId: string): Promise<TokenCheck> {
  try {
    return classifyToken(await fb.inspectOwnToken(revealSecret(page.pageAccessToken)), currentAppId);
  } catch (error) {
    return classifyInspectError(error);
  }
}

function toData(check: TokenCheck): Prisma.FacebookPageUpdateInput {
  return {
    tokenStatus: check.tokenStatus,
    // Keep the last known app when Graph could not answer this time
    ...(check.tokenAppId || check.tokenStatus !== 'ERROR' ? { tokenAppId: check.tokenAppId } : {}),
    tokenExpiresAt: check.tokenExpiresAt,
    missingScopes: check.missingScopes,
    tokenError: check.tokenError,
    tokenCheckedAt: new Date(),
  };
}

async function clientFor(userId: string) {
  const settings = await getSettings(userId);
  const fb = new FacebookClient({ appId: settings.fbAppId, appSecret: settings.fbAppSecret, graphVersion: settings.fbGraphVersion });
  return { fb, currentAppId: settings.fbAppId };
}

/** Check one Page now and store the result. */
export async function checkPage(userId: string, pageDbId: string): Promise<FacebookPage> {
  const page = await prisma.facebookPage.findFirstOrThrow({ where: { id: pageDbId, userId } });
  const { fb, currentAppId } = await clientFor(userId);
  return prisma.facebookPage.update({ where: { id: page.id }, data: toData(await inspectPageToken(fb, page, currentAppId)) });
}

/**
 * Check every connected Page (or only those never checked), a few at a time.
 * Returns the updated rows.
 */
export async function checkPages(userId: string, options: { onlyUnchecked?: boolean } = {}): Promise<FacebookPage[]> {
  const pages = await prisma.facebookPage.findMany({
    where: { userId, isActive: true, ...(options.onlyUnchecked && { tokenStatus: 'UNCHECKED' }) },
    orderBy: { pageName: 'asc' },
  });
  if (pages.length === 0) return [];
  const { fb, currentAppId } = await clientFor(userId);

  const updated: FacebookPage[] = [];
  const CONCURRENCY = 4;
  for (let i = 0; i < pages.length; i += CONCURRENCY) {
    const batch = pages.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map((p) => inspectPageToken(fb, p, currentAppId)));
    for (const [j, check] of results.entries()) {
      updated.push(await prisma.facebookPage.update({ where: { id: batch[j].id }, data: toData(check) }));
    }
  }
  return updated;
}

/** Fill token info for Pages connected before health tracking existed. Runs at startup. */
export async function checkUncheckedPages(): Promise<void> {
  const users = await prisma.facebookPage.findMany({
    where: { isActive: true, tokenStatus: 'UNCHECKED' },
    select: { userId: true },
    distinct: ['userId'],
  });
  for (const { userId } of users) {
    try {
      const pages = await checkPages(userId, { onlyUnchecked: true });
      if (pages.length) logger.info(`[Pages] Checked ${pages.length} Page token(s)`, { userId });
    } catch (error) {
      logger.error('[Pages] Token check failed', { userId, error: (error as Error).message });
    }
  }
}

// ─── Postable ───────────────────────────────────

export type BlockReason = 'DISCONNECTED' | 'OTHER_APP' | 'EXPIRED' | 'REVOKED' | 'MISSING_PERMISSIONS';

type HealthFields = Pick<FacebookPage, 'isActive' | 'tokenStatus' | 'tokenAppId' | 'missingScopes'>;

/**
 * Why this Page cannot be published to right now, or null when it can.
 * The app check uses the stored tokenAppId, so changing the App ID in Settings
 * blocks old-app Pages immediately, without re-checking them.
 * UNCHECKED / ERROR do not block: not knowing is not a reason to stop publishing.
 */
export function blockReason(page: HealthFields, currentAppId: string): BlockReason | null {
  if (!page.isActive) return 'DISCONNECTED';
  if (currentAppId && page.tokenAppId && page.tokenAppId !== currentAppId) return 'OTHER_APP';
  if (page.tokenStatus === 'OTHER_APP') return currentAppId && page.tokenAppId === currentAppId ? null : 'OTHER_APP';
  if (page.tokenStatus === 'EXPIRED' || page.tokenStatus === 'REVOKED' || page.tokenStatus === 'MISSING_PERMISSIONS') {
    return page.tokenStatus;
  }
  return null;
}

export function blockMessage(reason: BlockReason, page: HealthFields): string {
  switch (reason) {
    case 'DISCONNECTED':
      return 'Page đã ngắt kết nối.';
    case 'OTHER_APP':
      return `Token do Facebook App khác cấp${page.tokenAppId ? ` (${page.tokenAppId})` : ''}. Cần đồng bộ lại Page bằng App hiện tại.`;
    case 'EXPIRED':
      return 'Token đã hết hạn. Cần đồng bộ lại Page.';
    case 'REVOKED':
      return 'Token không còn hiệu lực (bị thu hồi hoặc đổi mật khẩu). Cần đồng bộ lại Page.';
    case 'MISSING_PERMISSIONS': {
      const scopes = Array.isArray(page.missingScopes) ? (page.missingScopes as string[]).join(', ') : '';
      return `Token thiếu quyền${scopes ? ` ${scopes}` : ''}. Cần đồng bộ lại và tick đủ quyền.`;
    }
  }
}

/** Page as returned by the API: health fields + whether it can be published to. */
export function withPostable<T extends HealthFields>(page: T, currentAppId: string) {
  const reason = blockReason(page, currentAppId);
  return { ...page, postable: reason === null, blockReason: reason, blockMessage: reason ? blockMessage(reason, page) : null };
}
