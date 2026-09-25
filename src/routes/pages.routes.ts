import { Router, Response } from 'express';
import { z } from 'zod';
import prisma from '../utils/prisma';
import { AuthRequest, authenticate } from '../middleware/auth.middleware';
import { asyncHandler, createError } from '../middleware/error.middleware';
import { config } from '../config';
import * as facebookService from '../services/facebook.service';
import { logger } from '../utils/logger';
import { encrypt } from '../lib/crypto';
import { getSettings } from '../lib/settings';
import { checkPage, checkPages, withPostable } from '../lib/page-health';
import { applySync, previewSync, SyncError, syncErrorMessage } from '../lib/page-sync';
import { redactSecrets } from '../lib/http';

const router = Router();

// All routes require authentication
router.use(authenticate);

/** Page fields the client may see (never the token). */
const publicPageSelect = {
  id: true,
  pageId: true,
  pageName: true,
  pageCategory: true,
  pageAvatar: true,
  isActive: true,
  tokenAppId: true,
  tokenStatus: true,
  tokenExpiresAt: true,
  missingScopes: true,
  tokenCheckedAt: true,
  tokenError: true,
  createdAt: true,
} as const;

/** Every Page with `postable` / `blockReason` / `blockMessage` for the current App ID. */
async function listPages(userId: string) {
  const [pages, settings] = await Promise.all([
    prisma.facebookPage.findMany({
      where: { userId },
      select: { ...publicPageSelect, _count: { select: { posts: true } } },
      orderBy: { createdAt: 'desc' },
    }),
    getSettings(userId),
  ]);
  return { appId: settings.fbAppId, pages: pages.map((p) => withPostable(p, settings.fbAppId)) };
}

/** Token fields reset whenever a new token is stored, then re-checked. */
const tokenReset = { tokenStatus: 'UNCHECKED' as const, tokenAppId: null, tokenExpiresAt: null, tokenError: null, tokenCheckedAt: null };

// ─── List Connected Pages ───────────────────────

router.get(
  '/',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const { appId, pages } = await listPages(req.user!.id);
    res.json({ success: true, data: pages, meta: { appId } });
  })
);

// ─── Sync Pages with the current Facebook App ───

router.post(
  '/sync/preview',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const { userToken } = z
      .object({ userToken: z.string().trim().min(20, 'Dán User Access Token (chuỗi bắt đầu bằng EAA…)') })
      .parse(req.body);
    try {
      res.json({ success: true, data: await previewSync(req.user!.id, userToken) });
    } catch (error) {
      if (!(error instanceof SyncError)) throw error;
      const message = redactSecrets(syncErrorMessage(error), [userToken]);
      logger.warn('Page sync preview failed', { step: error.step, error: message });
      throw createError(400, error.errorCode ? `${message} (${error.errorCode})` : message);
    }
  })
);

router.post(
  '/sync/apply',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const { refs, disconnect } = z
      .object({ refs: z.array(z.string()).max(200).default([]), disconnect: z.array(z.string().uuid()).max(200).default([]) })
      .refine((d) => d.refs.length + d.disconnect.length > 0, 'Chưa chọn thay đổi nào')
      .parse(req.body);
    try {
      const result = await applySync(req.user!.id, refs, disconnect);
      logger.info('Pages synced', { userId: req.user!.id, ...result });
      const { appId, pages } = await listPages(req.user!.id);
      res.json({ success: true, data: { ...result, pages }, meta: { appId } });
    } catch (error) {
      if (error instanceof SyncError) throw createError(400, syncErrorMessage(error));
      throw error;
    }
  })
);

// ─── Check Page Tokens ──────────────────────────

router.post(
  '/check',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    await checkPages(req.user!.id);
    const { appId, pages } = await listPages(req.user!.id);
    res.json({ success: true, data: pages, meta: { appId } });
  })
);

router.post(
  '/:id/check',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const page = await prisma.facebookPage.findFirst({ where: { id: req.params.id, userId: req.user!.id } });
    if (!page) throw createError(404, 'Page not found');
    await checkPage(req.user!.id, page.id);
    const { pages } = await listPages(req.user!.id);
    res.json({ success: true, data: pages.find((p) => p.id === page.id) });
  })
);

// ─── Connect Facebook Pages ─────────────────────

const connectPagesSchema = z.object({
  pages: z.array(
    z.object({
      pageId: z.string(),
      pageName: z.string(),
      accessToken: z.string(),
      category: z.string().optional(),
      picture: z.string().optional(),
    })
  ),
});

router.post(
  '/connect',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const { pages } = connectPagesSchema.parse(req.body);
    const userId = req.user!.id;

    // Check plan limits
    const planLimit = config.planLimits[req.user!.plan as keyof typeof config.planLimits];
    const existingCount = await prisma.facebookPage.count({ where: { userId } });

    if (planLimit.maxPages !== -1 && existingCount + pages.length > planLimit.maxPages) {
      throw createError(
        403,
        `Your ${req.user!.plan} plan allows max ${planLimit.maxPages} pages. Currently: ${existingCount}`
      );
    }

    // Upsert pages
    const connected = await Promise.all(
      pages.map((page) =>
        prisma.facebookPage.upsert({
          where: {
            userId_pageId: { userId, pageId: page.pageId },
          },
          create: {
            userId,
            pageId: page.pageId,
            pageName: page.pageName,
            pageAccessToken: encrypt(page.accessToken),
            pageCategory: page.category,
            pageAvatar: page.picture,
          },
          update: {
            pageName: page.pageName,
            pageAccessToken: encrypt(page.accessToken),
            pageCategory: page.category,
            pageAvatar: page.picture,
            isActive: true,
            ...tokenReset,
          },
          select: {
            id: true,
            pageId: true,
            pageName: true,
            pageCategory: true,
            pageAvatar: true,
            isActive: true,
          },
        })
      )
    );

    logger.info('Pages connected', { userId, count: connected.length });
    await checkPages(userId, { onlyUnchecked: true }).catch((e) => logger.warn('Page check failed', { error: (e as Error).message }));

    res.status(201).json({ success: true, data: connected });
  })
);

// ─── Disconnect Page ────────────────────────────

router.delete(
  '/:id',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const page = await prisma.facebookPage.findFirst({
      where: { id: req.params.id, userId: req.user!.id },
    });

    if (!page) throw createError(404, 'Page not found');

    await prisma.facebookPage.update({
      where: { id: req.params.id },
      data: { isActive: false },
    });

    res.json({ success: true, message: 'Page disconnected' });
  })
);

// ─── Refresh Page Token ─────────────────────────

router.post(
  '/:id/refresh-token',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const { accessToken } = z.object({ accessToken: z.string() }).parse(req.body);

    const page = await prisma.facebookPage.findFirst({
      where: { id: req.params.id, userId: req.user!.id },
    });

    if (!page) throw createError(404, 'Page not found');

    await prisma.facebookPage.update({
      where: { id: req.params.id },
      data: { pageAccessToken: encrypt(accessToken), ...tokenReset },
    });
    await checkPage(req.user!.id, page.id).catch((e) => logger.warn('Page check failed', { error: (e as Error).message }));

    res.json({ success: true, message: 'Token refreshed' });
  })
);

export default router;
