import { Router, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { config } from '../config';
import prisma from '../utils/prisma';
import { AuthRequest, authenticate } from '../middleware/auth.middleware';
import { asyncHandler, createError } from '../middleware/error.middleware';
import * as facebookService from '../services/facebook.service';
import { sendWelcomeEmail } from '../services/email.service';
import { logger } from '../utils/logger';

const router = Router();

// ─── Validation Schemas ─────────────────────────

const registerSchema = z.object({
  email: z.string().email('Invalid email'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  name: z.string().min(2, 'Name must be at least 2 characters'),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string(),
});

// ─── Register ───────────────────────────────────

router.post(
  '/register',
  asyncHandler(async (req, res) => {
    const { email, password, name } = registerSchema.parse(req.body);

    // Check if user exists
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      throw createError(409, 'Email already registered');
    }

    // Hash password
    const passwordHash = await bcrypt.hash(password, 12);

    // Create user
    const user = await prisma.user.create({
      data: { email, passwordHash, name },
      select: { id: true, email: true, name: true, plan: true, createdAt: true },
    });

    // Generate JWT
    const token = jwt.sign(
      { userId: user.id, email: user.email },
      config.jwt.secret,
      { expiresIn: config.jwt.expiresIn as jwt.SignOptions['expiresIn'] }
    );

    // Send welcome email (async, don't wait)
    sendWelcomeEmail(email, name).catch(() => {});

    logger.info('User registered', { userId: user.id, email });

    res.status(201).json({
      success: true,
      data: { user, token },
    });
  })
);

// ─── Login ──────────────────────────────────────

router.post(
  '/login',
  asyncHandler(async (req, res) => {
    const { email, password } = loginSchema.parse(req.body);

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user || !user.passwordHash) {
      throw createError(401, 'Invalid email or password');
    }

    const isValid = await bcrypt.compare(password, user.passwordHash);
    if (!isValid) {
      throw createError(401, 'Invalid email or password');
    }

    if (!user.isActive) {
      throw createError(403, 'Account is deactivated');
    }

    // Update last login
    await prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    const token = jwt.sign(
      { userId: user.id, email: user.email },
      config.jwt.secret,
      { expiresIn: config.jwt.expiresIn as jwt.SignOptions['expiresIn'] }
    );

    res.json({
      success: true,
      data: {
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          plan: user.plan,
          avatar: user.avatar,
        },
        token,
      },
    });
  })
);

// ─── Get Current User ───────────────────────────

router.get(
  '/me',
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.id },
      select: {
        id: true,
        email: true,
        name: true,
        avatar: true,
        plan: true,
        planExpiresAt: true,
        createdAt: true,
        _count: { select: { pages: true, posts: true, templates: true } },
      },
    });

    res.json({ success: true, data: user });
  })
);

// ─── Facebook OAuth ─────────────────────────────

router.get('/facebook', (req, res) => {
  // Generate state token (CSRF protection)
  const state = jwt.sign({ ts: Date.now() }, config.jwt.secret, { expiresIn: '10m' });
  const loginUrl = facebookService.getLoginUrl(state);
  res.json({ success: true, data: { loginUrl } });
});

router.get(
  '/facebook/callback',
  asyncHandler(async (req, res) => {
    const { code, state } = req.query as { code: string; state: string };

    if (!code) {
      throw createError(400, 'Authorization code required');
    }

    // Verify state token
    try {
      jwt.verify(state, config.jwt.secret);
    } catch {
      throw createError(400, 'Invalid or expired state token');
    }

    // Exchange code for token
    const { accessToken } = await facebookService.exchangeCodeForToken(code);

    // Get long-lived token
    const longLived = await facebookService.getLongLivedToken(accessToken);

    // Get user info
    const fbUser = await facebookService.getUserInfo(longLived.accessToken);

    // Get user's pages
    const pages = await facebookService.getUserPages(longLived.accessToken);

    // Redirect to frontend with data
    const data = encodeURIComponent(JSON.stringify({
      facebookUserId: fbUser.id,
      facebookName: fbUser.name,
      token: longLived.accessToken,
      expiresIn: longLived.expiresIn,
      pages: pages.map((p) => ({
        id: p.id,
        name: p.name,
        accessToken: p.access_token,
        category: p.category,
        picture: p.picture?.data?.url,
      })),
    }));

    res.redirect(`${config.clientUrl}/auth/facebook/callback?data=${data}`);
  })
);

// ─── Generate API Key ───────────────────────────

router.post(
  '/api-keys',
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const { name } = z.object({ name: z.string().min(1) }).parse(req.body);

    const { v4: uuidv4 } = await import('uuid');
    const key = `ap_${uuidv4().replace(/-/g, '')}`;

    const apiKey = await prisma.apiKey.create({
      data: {
        userId: req.user!.id,
        key,
        name,
        expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000), // 1 year
      },
      select: { id: true, key: true, name: true, createdAt: true, expiresAt: true },
    });

    res.status(201).json({ success: true, data: apiKey });
  })
);

export default router;
