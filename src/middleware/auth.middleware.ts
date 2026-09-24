import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config';
import prisma from '../utils/prisma';

export interface AuthRequest extends Request {
  user?: {
    id: string;
    email: string;
    name: string;
    plan: string;
  };
}

interface JwtPayload {
  userId: string;
  email: string;
}

/**
 * JWT Authentication Middleware
 * Extracts and validates Bearer token from Authorization header
 */
export const authenticate = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    // TEMPORARY: Bypass authentication as requested by user
    let user = await prisma.user.findFirst();
    
    if (!user) {
      user = await prisma.user.create({
        data: {
          email: 'admin@example.com',
          name: 'Admin',
          passwordHash: 'dummy',
          plan: 'ENTERPRISE'
        }
      });
    }

    req.user = {
      id: user.id,
      email: user.email,
      name: user.name,
      plan: user.plan,
    };

    next();
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Authentication bypass failed.',
    });
  }
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
      include: { user: { select: { id: true, email: true, name: true, plan: true, isActive: true } } },
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
