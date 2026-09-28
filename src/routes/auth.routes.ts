import { Router, Response } from 'express';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import prisma from '../utils/prisma';
import { AuthRequest, authenticate } from '../middleware/auth.middleware';
import { asyncHandler, createError } from '../middleware/error.middleware';
import { clearSessionCookie, setSessionCookie } from '../lib/session';
import { normalizeEmail, verifyPassword } from '../lib/passwords';
import { limiterKey, loginLimiter } from '../lib/login-limiter';
import { logger } from '../utils/logger';

/** Accounts are created and edited by the admin (routes/admin.routes.ts); users only log in. */
const router = Router();

const publicUserSelect = { id: true, email: true, name: true, role: true } as const;

router.post(
  '/login',
  asyncHandler(async (req, res) => {
    const body = z.object({ email: z.string().min(1), password: z.string().min(1) }).parse(req.body);
    const email = normalizeEmail(body.email);
    const key = limiterKey(email, req.ip);

    const wait = loginLimiter.retryAfterSeconds(key);
    if (wait) {
      res.setHeader('Retry-After', String(wait));
      throw createError(429, `Đăng nhập sai quá nhiều lần. Thử lại sau ${Math.ceil(wait / 60)} phút.`, { code: 'LOGIN_LOCKED' });
    }

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user || !user.isActive || !(await verifyPassword(body.password, user.passwordHash))) {
      loginLimiter.fail(key);
      throw createError(401, 'Email hoặc mật khẩu không đúng.', { code: 'BAD_CREDENTIALS' });
    }

    loginLimiter.reset(key);
    const updated = await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    setSessionCookie(res, updated);
    logger.info('User logged in', { userId: user.id });
    res.json({ success: true, data: { id: updated.id, email: updated.email, name: updated.name, role: updated.role } });
  })
);

// Works with an expired session too
router.post('/logout', (_req, res) => {
  clearSessionCookie(res);
  res.json({ success: true });
});

router.get(
  '/me',
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: req.user!.id }, select: publicUserSelect });
    res.json({ success: true, data: user });
  })
);

// API keys for external integrations
router.post(
  '/api-keys',
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const { name } = z.object({ name: z.string().min(1) }).parse(req.body);
    const apiKey = await prisma.apiKey.create({
      data: {
        userId: req.user!.id,
        key: `ap_${randomUUID().replace(/-/g, '')}`,
        name,
        expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000), // 1 year
      },
      select: { id: true, key: true, name: true, createdAt: true, expiresAt: true },
    });
    res.status(201).json({ success: true, data: apiKey });
  })
);

export default router;
