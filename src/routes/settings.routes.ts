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
import { FacebookApiError, FacebookClient } from '../lib/clients/facebook';
import { logger } from '../utils/logger';
import { blockMessage, blockReason, checkPage, checkPages } from '../lib/page-health';

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
  const saved = await prisma.facebookPage.upsert({
    where: { userId_pageId: { userId, pageId: page.id } },
    create: { userId, pageId: page.id, pageName: page.name, pageCategory: page.category, pageAccessToken },
    update: {
      pageName: page.name,
      pageCategory: page.category,
      pageAccessToken,
      isActive: true,
      // New token: forget the old one's health, then check it
      tokenStatus: 'UNCHECKED',
      tokenAppId: null,
      tokenExpiresAt: null,
      tokenError: null,
      tokenCheckedAt: null,
    },
    select: { id: true, pageId: true, pageName: true, pageCategory: true },
  });
  await checkPage(userId, saved.id).catch((e) => logger.warn('Page check failed', { error: (e as Error).message }));
  return saved;
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

  if (pageDbId && !(await prisma.facebookPage.findFirst({ where: { id: pageDbId, userId } }))) {
    throw createError(404, 'Page not found');
  }

  // 2. Every connected Page token (stored, so the Pages screen shows the same result)
  const checked = pageDbId ? [await checkPage(userId, pageDbId)] : await checkPages(userId);
  if (checked.length === 0) {
    return { ok: true, message: 'App ID / App Secret hợp lệ. Chưa có Page nào được kết nối.', details: { type: app.type } };
  }

  const rows = checked.map((page) => ({ page, reason: blockReason(page, settings.fbAppId) }));
  const names = (list: typeof rows) => list.map((r) => `"${r.page.pageName}"`).join(', ');
  const otherApp = rows.filter((r) => r.reason === 'OTHER_APP');
  const blocked = rows.filter((r) => r.reason && r.reason !== 'OTHER_APP');
  const unknown = rows.filter((r) => !r.reason && r.page.tokenStatus === 'ERROR');
  const details = {
    appId: settings.fbAppId,
    pages: checked.map((p) => ({
      pageName: p.pageName,
      pageId: p.pageId,
      tokenStatus: p.tokenStatus,
      tokenAppId: p.tokenAppId,
      expiresAt: p.tokenExpiresAt,
      error: p.tokenError,
    })),
  };

  if (otherApp.length) {
    const apps = [...new Set(otherApp.map((r) => r.page.tokenAppId).filter(Boolean))].join(', ');
    return {
      ok: false,
      message:
        `App ID / App Secret hợp lệ, nhưng ${otherApp.length}/${checked.length} Page vẫn dùng token do app khác cấp${apps ? ` (${apps})` : ''}: ${names(otherApp)}. ` +
        'Các Page này sẽ bị chặn đăng cho tới khi cấp lại token. ' +
        'Lấy User token từ app hiện tại (Graph API Explorer → chọn app ' + settings.fbAppId + ' → quyền pages_manage_posts, pages_read_engagement, pages_show_list) rồi bấm "Đổi token dài hạn" và chọn lại các Page.',
      details,
    };
  }
  if (blocked.length) {
    return {
      ok: false,
      message: `Có ${blocked.length}/${checked.length} Page cần xử lý: ${blocked.map((r) => `"${r.page.pageName}": ${blockMessage(r.reason!, r.page)}`).join('; ')}`,
      details,
    };
  }
  if (unknown.length) {
    return { ok: false, message: `Chưa kiểm tra được ${names(unknown)}: ${unknown[0].page.tokenError ?? 'lỗi không rõ'}`, details };
  }

  const expiries = checked.flatMap((p) => (p.tokenExpiresAt ? [p.tokenExpiresAt.getTime()] : [])).sort((a, b) => a - b);
  const label = checked.length === 1 ? `Token Page "${checked[0].pageName}"` : `Token của ${checked.length} Page`;
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
