import { Router, Response } from 'express';
import { z } from 'zod';
import prisma from '../utils/prisma';
import { AuthRequest, authenticate } from '../middleware/auth.middleware';
import { asyncHandler, createError } from '../middleware/error.middleware';

const router = Router();
router.use(authenticate);

// ─── Validation Schemas ─────────────────────────

const createTemplateSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().optional(),
  promptTemplate: z.string().min(10, 'Prompt template must be at least 10 characters'),
  imagePrompt: z.string().optional(),
  hashtags: z.array(z.string()).optional(),
  category: z.string().optional(),
  variables: z
    .array(
      z.object({
        name: z.string(),
        type: z.enum(['string', 'number', 'date']),
        required: z.boolean().optional(),
        defaultValue: z.string().optional(),
      })
    )
    .optional(),
});

// ─── List Templates ─────────────────────────────

router.get(
  '/',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const { category, search } = req.query;

    const templates = await prisma.contentTemplate.findMany({
      where: {
        userId: req.user!.id,
        isActive: true,
        ...(category && { category: category as string }),
        ...(search && {
          OR: [
            { name: { contains: search as string } },
            { description: { contains: search as string } },
          ],
        }),
      },
      select: {
        id: true,
        name: true,
        description: true,
        promptTemplate: true,
        imagePrompt: true,
        hashtags: true,
        category: true,
        variables: true,
        createdAt: true,
        updatedAt: true,
        _count: { select: { posts: true } },
      },
      orderBy: { updatedAt: 'desc' },
    });

    res.json({ success: true, data: templates });
  })
);

// ─── Get Single Template ────────────────────────

router.get(
  '/:id',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const template = await prisma.contentTemplate.findFirst({
      where: { id: req.params.id, userId: req.user!.id, isActive: true },
      include: { _count: { select: { posts: true } } },
    });

    if (!template) throw createError(404, 'Template not found');

    res.json({ success: true, data: template });
  })
);

// ─── Create Template ────────────────────────────

router.post(
  '/',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const data = createTemplateSchema.parse(req.body);

    const template = await prisma.contentTemplate.create({
      data: {
        userId: req.user!.id,
        ...data,
      },
    });

    res.status(201).json({ success: true, data: template });
  })
);

// ─── Update Template ────────────────────────────

router.put(
  '/:id',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const data = createTemplateSchema.partial().parse(req.body);

    const template = await prisma.contentTemplate.findFirst({
      where: { id: req.params.id, userId: req.user!.id },
    });

    if (!template) throw createError(404, 'Template not found');

    const updated = await prisma.contentTemplate.update({
      where: { id: req.params.id },
      data,
    });

    res.json({ success: true, data: updated });
  })
);

// ─── Delete Template (soft) ─────────────────────

router.delete(
  '/:id',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const template = await prisma.contentTemplate.findFirst({
      where: { id: req.params.id, userId: req.user!.id },
    });

    if (!template) throw createError(404, 'Template not found');

    await prisma.contentTemplate.update({
      where: { id: req.params.id },
      data: { isActive: false },
    });

    res.json({ success: true, message: 'Template deleted' });
  })
);

export default router;
