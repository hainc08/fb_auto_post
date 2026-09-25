import { Request, Response, NextFunction } from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Site-wide HTTP Basic Auth gate for deployments where the app is public on the
 * internet while in-app login is still bypassed (see auth.middleware.ts).
 * Enabled only when BASIC_AUTH_USER and BASIC_AUTH_PASS are both set.
 * /health stays open for uptime monitors.
 */

const sha256 = (value: string) => createHash('sha256').update(value).digest();

/** Constant-time comparison (hashing first makes lengths equal). */
const safeEqual = (a: string, b: string) => timingSafeEqual(sha256(a), sha256(b));

export function basicAuthGate(user: string | undefined, pass: string | undefined) {
  if (!user || !pass) return null;

  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.path === '/health') return next();

    const header = req.headers.authorization ?? '';
    if (header.startsWith('Basic ')) {
      const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
      const sep = decoded.indexOf(':');
      if (sep !== -1 && safeEqual(decoded.slice(0, sep), user) && safeEqual(decoded.slice(sep + 1), pass)) {
        return next();
      }
    }

    res.setHeader('WWW-Authenticate', 'Basic realm="Auto Post", charset="UTF-8"');
    res.status(401).send('Authentication required');
  };
}
