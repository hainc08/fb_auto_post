import { Request, Response, NextFunction } from 'express';
import prisma from '../utils/prisma';
import { createError } from './error.middleware';
import { readSessionToken, verifySession } from '../lib/session';

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  plan: string;
  role: 'ADMIN' | 'USER';
}

export interface AuthRequest extends Request {
  user?: AuthUser;
}

/** Session cookie ⇒ req.user. Every /api route except login/logout uses this. */
export const authenticate = async (req: AuthRequest, _res: Response, next: NextFunction): Promise<void> => {
  try {
    const token = readSessionToken(req);
    const claims = token ? verifySession(token) : null;
    if (!claims) return next(createError(401, 'Vui lòng đăng nhập.', { code: 'UNAUTHENTICATED' }));

    const user = await prisma.user.findUnique({
      where: { id: claims.sub },
      select: { id: true, email: true, name: true, plan: true, role: true, isActive: true, tokenVersion: true },
    });
    if (!user || !user.isActive || user.tokenVersion !== claims.tv) {
      return next(createError(401, 'Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.', { code: 'UNAUTHENTICATED' }));
    }

    req.user = { id: user.id, email: user.email, name: user.name, plan: user.plan, role: user.role };
    next();
  } catch (error) {
    next(error);
  }
};

export const requireAdmin = (req: AuthRequest, _res: Response, next: NextFunction): void => {
  if (req.user?.role !== 'ADMIN') {
    return next(createError(403, 'Chỉ quản trị viên mới dùng được chức năng này.', { code: 'FORBIDDEN' }));
  }
  next();
};

/** CSRF: browsers cannot add custom headers cross-site without a CORS preflight we do not allow. */
export const csrfGuard = (req: Request, _res: Response, next: NextFunction): void => {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  if (req.get('x-requested-with') !== 'autopost') {
    return next(createError(403, 'Yêu cầu không hợp lệ (thiếu X-Requested-With).', { code: 'CSRF' }));
  }
  next();
};

/**
 * API Key Authentication Middleware (for external integrations)
 */
export const authenticateApiKey = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const apiKey = req.headers['x-api-key'] as string;

    if (!apiKey) {
      res.status(401).json({
        success: false,
        error: 'API key required. Provide X-API-Key header.',
      });
      return;
    }

    const key = await prisma.apiKey.findUnique({
      where: { key: apiKey },
      include: { user: { select: { id: true, email: true, name: true, plan: true, role: true, isActive: true } } },
    });

    if (!key || !key.isActive || !key.user.isActive) {
      res.status(401).json({
        success: false,
        error: 'Invalid or expired API key.',
      });
      return;
    }

    // Check expiration
    if (key.expiresAt && key.expiresAt < new Date()) {
      res.status(401).json({
        success: false,
        error: 'API key has expired.',
      });
      return;
    }

    // Update last used
    await prisma.apiKey.update({
      where: { id: key.id },
      data: { lastUsed: new Date() },
    });

    req.user = {
      id: key.user.id,
      email: key.user.email,
      name: key.user.name,
      plan: key.user.plan,
      role: key.user.role,
    };

    next();
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Authentication failed.',
    });
  }
};

/**
 * Plan-based authorization middleware
 */
export const requirePlan = (...allowedPlans: string[]) => {
  return (req: AuthRequest, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ success: false, error: 'Authentication required.' });
      return;
    }

    if (!allowedPlans.includes(req.user.plan)) {
      res.status(403).json({
        success: false,
        error: `This feature requires one of the following plans: ${allowedPlans.join(', ')}. Current plan: ${req.user.plan}`,
      });
      return;
    }

    next();
  };
};
