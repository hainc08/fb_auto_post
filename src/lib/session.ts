import jwt from 'jsonwebtoken';
import type { CookieOptions, Request, Response } from 'express';
import { config } from '../config';

/**
 * Login session: a JWT `{ sub: userId, tv: tokenVersion }` in an httpOnly cookie.
 * Bumping User.tokenVersion (disable, admin changes password/email/role) ends every session.
 */

export const SESSION_COOKIE = 'ap_session';
export const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface SessionClaims {
  sub: string;
  tv: number;
}

type SessionUser = { id: string; tokenVersion: number };

export function signSession(user: SessionUser): string {
  return jwt.sign({ tv: user.tokenVersion }, config.jwt.secret, {
    subject: user.id,
    expiresIn: Math.floor(SESSION_MAX_AGE_MS / 1000),
  });
}

export function verifySession(token: string): SessionClaims | null {
  try {
    const payload = jwt.verify(token, config.jwt.secret) as jwt.JwtPayload;
    if (typeof payload.sub !== 'string' || typeof payload.tv !== 'number') return null;
    return { sub: payload.sub, tv: payload.tv };
  } catch {
    return null;
  }
}

/** Minimal cookie parsing (no cookie-parser dependency). */
export function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

export const readSessionToken = (req: Request) => readCookie(req.headers.cookie, SESSION_COOKIE);

function cookieOptions(): CookieOptions {
  return { httpOnly: true, sameSite: 'lax', secure: config.env === 'production', path: '/', maxAge: SESSION_MAX_AGE_MS };
}

export function setSessionCookie(res: Response, user: SessionUser): void {
  res.cookie(SESSION_COOKIE, signSession(user), cookieOptions());
}

export function clearSessionCookie(res: Response): void {
  const { maxAge: _maxAge, ...options } = cookieOptions();
  res.clearCookie(SESSION_COOKIE, options);
}

/** `Cookie` header value for tests and scripts. */
export const sessionCookie = (user: SessionUser) => `${SESSION_COOKIE}=${signSession(user)}`;
