import { Router, Response } from 'express';
import { z } from 'zod';
import prisma from '../utils/prisma';
import { AuthRequest, authenticate } from '../middleware/auth.middleware';
import { asyncHandler, createError } from '../middleware/error.middleware';
import { getPublicSettings, getSettings, revealSecret, saveSettings, settingsInputSchema } from '../lib/settings';
import { decrypt, encrypt } from '../lib/crypto';
import { redactSecrets } from '../lib/http';
import { GeminiClient } from '../lib/clients/gemini';
import { CloudflareClient } from '../lib/clients/cloudflare';
import { FacebookApiError, FacebookClient, OTHER_APP_TOKEN_MESSAGE, type TokenDebugInfo } from '../lib/clients/facebook';
import { logger } from '../utils/logger';

const router = Router();
router.use(authenticate);

// ─── Helpers ────────────────────────────────────

interface TestResult {
  ok: boolean;
  message: string;
  code?: string;
  details?: Record<string, unknown>;
}

/** Connection-test failures are results, not HTTP errors. Messages are already redacted. */
function failure(error: unknown, secrets: string[]): TestResult {
  const err = error as Error & { errorCode?: string };
  return { ok: false, message: redactSecrets(err.message ?? String(error), secrets), code: err.errorCode };
}

const withCode = (message: string, code?: string) => (code ? `${message} (${code})` : message);

function facebookClient(settings: Awaited<ReturnType<typeof getSettings>>) {
  return new FacebookClient(
    { appId: settings.fbAppId, appSecret: settings.fbAppSecret, graphVersion: settings.fbGraphVersion },
    [settings.fbAppSecret]
  );
}

async function upsertPage(userId: string, page: { id: string; name: string; category?: string; token: string }) {
  const pageAccessToken = encrypt(page.token);
  return prisma.facebookPage.upsert({
    where: { userId_pageId: { userId, pageId: page.id } },
    create: { userId, pageId: page.id, pageName: page.name, pageCategory: page.category, pageAccessToken },
    update: { pageName: page.name, pageCategory: page.category, pageAccessToken, isActive: true },
    select: { id: true, pageId: true, pageName: true, pageCategory: true },
  });
}

/**
 * Accept either a Page Access Token or a User Access Token for the manual flow.
 * A user token is swapped for that Page's own token via /me/accounts (a Page token
 * derived from a long-lived user token does not expire).
 */
async function resolvePageToken(fb: FacebookClient, pageId: string, token: string) {
  try {
    const pages = await fb.listPages(token);
    const match = pages.find((p) => p.id === pageId);
    if (match) {
      return { id: match.id, name: match.name, category: match.category, token: match.access_token, fromUserToken: true };
    }
    if (pages.length > 0) {
      throw new FacebookApiError(
        `Tài khoản của token này không quản trị Page ${pageId} (hoặc chưa cấp quyền Page này cho App khi tạo token).`
      );
    }
  } catch (error) {
    // Page tokens cannot call /me/accounts — fall through and treat it as a Page token
    if (error instanceof FacebookApiError && error.code === undefined) throw error;
  }

  const info = await fb.getPage(pageId, token);
  return { id: info.id, name: info.name, category: info.category, token, fromUserToken: false };
}

// ─── Get Settings (secrets masked) ──────────────

router.get(
  '/',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    res.json({ success: true, data: await getPublicSettings(req.user!.id) });
  })
);

// ─── Save Settings ──────────────────────────────

router.post(
  '/',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const { settings } = z.object({ settings: settingsInputSchema }).parse(req.body);

    if (settings.fbAppId) {
      const clash = await prisma.facebookPage.findFirst({ where: { userId: req.user!.id, pageId: settings.fbAppId } });
      if (clash) {
        throw createError(400, `${settings.fbAppId} là Page ID của "${clash.pageName}", không phải App ID. Nhập App ID của ứng dụng hoặc để trống.`);
      }
    }

    await saveSettings(req.user!.id, settings);
    res.json({ success: true, data: await getPublicSettings(req.user!.id) });
  })
);

// ─── Connection Tests ───────────────────────────

router.post(
  '/test/:group',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const settings = await getSettings(req.user!.id);
    const secrets = [settings.geminiApiKey, settings.cfApiToken, settings.fbAppSecret];
    let result: TestResult;

    try {
      switch (req.params.group) {
        case 'gemini': {
          const reply = await new GeminiClient({ apiKey: settings.geminiApiKey, model: settings.geminiModel }).ping();
          result = { ok: true, message: `Gemini hoạt động với model ${settings.geminiModel}.`, details: { reply } };
          break;
        }

        case 'cloudflare': {
          const info = await new CloudflareClient({
            accountId: settings.cfAccountId,
            apiToken: settings.cfApiToken,
            imageModel: settings.cfImageModel,
            steps: settings.cfSteps,
          }).verifyToken();
          result =
            info.status === 'active'
              ? { ok: true, message: 'Cloudflare API token hợp lệ.', details: { ...info } }
              : { ok: false, message: `Cloudflare token đang ở trạng thái "${info.status}".`, details: { ...info } };
          break;
        }

        case 'facebook': {
          result = await testFacebook(req.user!.id, settings, z.string().uuid().optional().parse(req.body?.pageId));
          break;
        }

        default:
          throw createError(404, 'Unknown settings group');
      }
    } catch (error) {
      if ((error as { statusCode?: number }).statusCode) throw error;
      result = failure(error, secrets);
    }

    res.json({ success: true, data: result });
  })
);

async function testFacebook(
  userId: string,
  settings: Awaited<ReturnType<typeof getSettings>>,
  pageDbId?: string
): Promise<TestResult> {
  const fb = facebookClient(settings);

  // 1. The App ID / App Secret themselves (throws a clear error when wrong)
  const app = await fb.debugToken(`${settings.fbAppId}|${settings.fbAppSecret}`);
  if (!app.isValid) {
    return { ok: false, message: 'App ID / App Secret không hợp lệ.', details: { error: app.error } };
  }

  const pages = await prisma.facebookPage.findMany({
    where: { userId, isActive: true, ...(pageDbId && { id: pageDbId }) },
    orderBy: { updatedAt: 'desc' },
  });
  if (pages.length === 0) {
    return { ok: true, message: 'App ID / App Secret hợp lệ. Chưa có Page nào được kết nối.', details: { type: app.type } };
  }

  // 2. Every connected Page token, against this app
  type PageCheck = { page: (typeof pages)[number] } & (
    | { kind: 'checked'; info: TokenDebugInfo }
    | { kind: 'other_app' }
    | { kind: 'error'; error: string }
  );
  const checks: PageCheck[] = await Promise.all(
    pages.map(async (page): Promise<PageCheck> => {
      try {
        return { page, kind: 'checked', info: await fb.debugToken(revealSecret(page.pageAccessToken)) };
      } catch (error) {
        if (error instanceof FacebookApiError && error.message === OTHER_APP_TOKEN_MESSAGE) return { page, kind: 'other_app' };
        return { page, kind: 'error', error: (error as Error).message };
      }
    })
  );

  const names = (list: typeof checks) => list.map((c) => `"${c.page.pageName}"`).join(', ');
  const otherApp = checks.filter((c) => c.kind === 'other_app');
  const problems = checks.flatMap((c) => {
    if (c.kind === 'error') return [`"${c.page.pageName}": ${c.error}`];
    if (c.kind !== 'checked') return [];
    const { info } = c;
    if (!info.isValid) return [`"${c.page.pageName}": token không hợp lệ${info.error ? ` (${info.error})` : ''}`];
    if (info.type !== 'PAGE') return [`"${c.page.pageName}": token loại ${info.type}, cần Page Access Token`];
    if (info.missingScopes.length) return [`"${c.page.pageName}": thiếu quyền ${info.missingScopes.join(', ')}`];
    return [];
  });
  const details = {
    appId: settings.fbAppId,
    pages: checks.map((c) => ({
      pageName: c.page.pageName,
      pageId: c.page.pageId,
      ...(c.kind === 'other_app' ? { tokenFromOtherApp: true } : {}),
      ...(c.kind === 'checked' ? { valid: c.info.isValid, expiresAt: c.info.expiresAt, missingScopes: c.info.missingScopes } : {}),
      ...(c.kind === 'error' ? { error: c.error } : {}),
    })),
  };

  if (otherApp.length) {
    return {
      ok: false,
      message:
        `App ID / App Secret hợp lệ, nhưng ${otherApp.length}/${pages.length} Page vẫn dùng token do app khác cấp: ${names(otherApp)}. ` +
        'Các Page này vẫn đăng bài bằng app cũ (nếu app cũ ở chế độ Development thì người khác không xem được bài). ' +
        'Lấy User token từ app mới (Graph API Explorer → chọn app mới → quyền pages_manage_posts, pages_read_engagement, pages_show_list) rồi bấm "Đổi token dài hạn" và chọn lại các Page.',
      details,
    };
  }
  if (problems.length) {
    return { ok: false, message: `Có ${problems.length}/${pages.length} Page cần xử lý: ${problems.join('; ')}.`, details };
  }

  const expiries = checks.flatMap((c) => (c.kind === 'checked' && c.info.expiresAt ? [c.info.expiresAt] : [])).sort();
  const label = pages.length === 1 ? `Token Page "${pages[0].pageName}"` : `Token của ${pages.length} Page`;
  return {
    ok: true,
    message: expiries.length
      ? `${label} hợp lệ, sớm nhất hết hạn ${new Date(expiries[0]).toLocaleString('vi-VN')}.`
      : `${label} hợp lệ, không hết hạn.`,
    details,
  };
}

// ─── Facebook: exchange short-lived user token → pick Pages ──

router.post(
  '/facebook/exchange-token',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const { shortToken } = z.object({ shortToken: z.string().trim().min(20) }).parse(req.body);
    const settings = await getSettings(req.user!.id);
    const fb = facebookClient(settings);

    let step = 'Đổi sang token dài hạn';
    try {
      const longUserToken = await fb.exchangeLongLivedUserToken(shortToken);
      step = 'Lấy danh sách Page';
      const pages = await fb.listPages(longUserToken);

      // Page tokens never go to the client in clear text: each page carries an
      // encrypted `ref` that the client sends back to connect it.
      const data = pages.map((p) => ({
        id: p.id,
        name: p.name,
        category: p.category,
        ref: encrypt(JSON.stringify({ id: p.id, name: p.name, category: p.category, token: p.access_token })),
      }));

      res.json({ success: true, data });
    } catch (error) {
      const err = error as Error & { errorCode?: string; rawMessage?: string };
      const secrets = [shortToken, settings.fbAppSecret];
      logger.warn('Facebook token exchange failed', { step, error: redactSecrets(err.message, secrets), raw: redactSecrets(err.rawMessage ?? '', secrets) });
      throw createError(400, withCode(`${step} thất bại: ${redactSecrets(err.message, secrets)}`, err.errorCode));
    }
  })
);

router.post(
  '/facebook/pages',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const { refs } = z.object({ refs: z.array(z.string()).min(1).max(50) }).parse(req.body);

    const pages = refs.map((ref) => {
      try {
        return z
          .object({ id: z.string(), name: z.string(), category: z.string().optional(), token: z.string() })
          .parse(JSON.parse(decrypt(ref)));
      } catch {
        throw createError(400, 'Dữ liệu Page không hợp lệ hoặc đã hết hạn. Hãy đổi token lại.');
      }
    });

    const connected = [];
    for (const page of pages) connected.push(await upsertPage(req.user!.id, page));

    res.status(201).json({ success: true, data: connected });
  })
);

router.post(
  '/facebook/pages/manual',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const { pageId, pageAccessToken } = z
      .object({ pageId: z.string().trim().regex(/^\d+$/, 'Page ID chỉ gồm chữ số'), pageAccessToken: z.string().trim().min(20) })
      .parse(req.body);
    const settings = await getSettings(req.user!.id);
    const fb = facebookClient(settings);

    let resolved: { id: string; name: string; category?: string; token: string; fromUserToken: boolean };
    try {
      resolved = await resolvePageToken(fb, pageId, pageAccessToken);
    } catch (error) {
      const err = error as Error & { errorCode?: string };
      throw createError(400, withCode(redactSecrets(err.message, [pageAccessToken]), err.errorCode));
    }

    const page = await upsertPage(req.user!.id, resolved);

    // Permission check needs App ID + App Secret; skip silently when not configured
    let warning: string | undefined;
    if (settings.fbAppId && settings.fbAppSecret) {
      try {
        const info = await fb.debugToken(resolved.token);
        if (info.missingScopes.length > 0) {
          warning = `Đã kết nối nhưng token thiếu quyền ${info.missingScopes.join(', ')} — chưa đăng bài được. Tạo lại token có tick các quyền này.`;
        }
      } catch {
        // informational only
      }
    }

    res.status(201).json({ success: true, data: { ...page, fromUserToken: resolved.fromUserToken, warning } });
  })
);

export default router;
