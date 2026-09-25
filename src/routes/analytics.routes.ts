import { Router, Response } from 'express';
import prisma from '../utils/prisma';
import { AuthRequest, authenticate } from '../middleware/auth.middleware';
import { asyncHandler } from '../middleware/error.middleware';

const router = Router();
router.use(authenticate);

// ─── Dashboard Overview ─────────────────────────

router.get(
  '/overview',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const userId = req.user!.id;

    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);

    const [
      totalPosts,
      publishedPosts,
      failedPosts,
      scheduledPosts,
      readyPosts,
      thisMonthPosts,
      lastMonthPosts,
      totalPages,
      totalTemplates,
      recentPosts,
    ] = await Promise.all([
      prisma.post.count({ where: { userId } }),
      prisma.post.count({ where: { userId, status: 'PUBLISHED' } }),
      prisma.post.count({ where: { userId, status: 'FAILED' } }),
      prisma.post.count({ where: { userId, status: 'SCHEDULED' } }),
      prisma.post.count({ where: { userId, status: 'READY' } }),
      prisma.post.count({
        where: { userId, createdAt: { gte: startOfMonth } },
      }),
      prisma.post.count({
        where: {
          userId,
          createdAt: { gte: startOfLastMonth, lt: startOfMonth },
        },
      }),
      prisma.facebookPage.count({ where: { userId, isActive: true } }),
      prisma.contentTemplate.count({ where: { userId, isActive: true } }),
      prisma.post.findMany({
        where: { userId },
        select: {
          id: true,
          caption: true,
          imageUrl: true,
          inputData: true,
          status: true,
          publishedAt: true,
          createdAt: true,
          page: { select: { pageName: true, pageAvatar: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: 10,
      }),
    ]);

    // Growth percentage
    const growth =
      lastMonthPosts > 0
        ? Math.round(((thisMonthPosts - lastMonthPosts) / lastMonthPosts) * 100)
        : thisMonthPosts > 0
          ? 100
          : 0;

    res.json({
      success: true,
      data: {
        stats: {
          totalPosts,
          publishedPosts,
          failedPosts,
          scheduledPosts,
          readyPosts,
          thisMonthPosts,
          growth,
          totalPages,
          totalTemplates,
          successRate:
            totalPosts > 0
              ? Math.round((publishedPosts / (publishedPosts + failedPosts || 1)) * 100)
              : 0,
        },
        recentPosts,
      },
    });
  })
);

// ─── Posts by Status Over Time ───────────────────

router.get(
  '/posts-timeline',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const userId = req.user!.id;
    const { days = '30' } = req.query;
    const daysNum = parseInt(days as string);

    const startDate = new Date();
    startDate.setDate(startDate.getDate() - daysNum);

    const posts = await prisma.post.findMany({
      where: {
        userId,
        createdAt: { gte: startDate },
      },
      select: {
        status: true,
        createdAt: true,
        publishedAt: true,
      },
      orderBy: { createdAt: 'asc' },
    });

    // Group by date
    const timeline: Record<string, { published: number; failed: number; total: number }> = {};

    for (let i = 0; i < daysNum; i++) {
      const date = new Date(startDate);
      date.setDate(date.getDate() + i);
      const key = date.toISOString().split('T')[0];
      timeline[key] = { published: 0, failed: 0, total: 0 };
    }

    for (const post of posts) {
      const key = post.createdAt.toISOString().split('T')[0];
      if (timeline[key]) {
        timeline[key].total++;
        if (post.status === 'PUBLISHED') timeline[key].published++;
        if (post.status === 'FAILED') timeline[key].failed++;
      }
    }

    res.json({
      success: true,
      data: Object.entries(timeline).map(([date, stats]) => ({
        date,
        ...stats,
      })),
    });
  })
);

// ─── Top Performing Pages ───────────────────────

router.get(
  '/pages-performance',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const userId = req.user!.id;

    const pages = await prisma.facebookPage.findMany({
      where: { userId, isActive: true },
      select: {
        id: true,
        pageName: true,
        pageAvatar: true,
        _count: {
          select: {
            posts: { where: { status: 'PUBLISHED' } },
          },
        },
      },
    });

    const performance = pages
      .map((p) => ({
        pageId: p.id,
        pageName: p.pageName,
        pageAvatar: p.pageAvatar,
        totalPublished: p._count.posts,
      }))
      .sort((a, b) => b.totalPublished - a.totalPublished);

    res.json({ success: true, data: performance });
  })
);

export default router;
