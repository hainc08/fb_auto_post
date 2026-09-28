import { describe, it, expect } from 'vitest';
import jwt from 'jsonwebtoken';
import { config } from '../src/config';
import { readCookie, sessionCookie, signSession, verifySession, SESSION_COOKIE } from '../src/lib/session';

describe('session token', () => {
  it('round-trips user id and token version', () => {
    expect(verifySession(signSession({ id: 'u1', tokenVersion: 3 }))).toEqual({ sub: 'u1', tv: 3 });
  });

  it('rejects tampered, foreign and expired tokens', () => {
    const token = signSession({ id: 'u1', tokenVersion: 0 });
    expect(verifySession(token.slice(0, -2) + 'xx')).toBeNull();
    expect(verifySession(jwt.sign({ tv: 0 }, 'another-secret', { subject: 'u1' }))).toBeNull();
    expect(verifySession(jwt.sign({ tv: 0 }, config.jwt.secret, { subject: 'u1', expiresIn: -10 }))).toBeNull();
  });

  it('rejects tokens without a token version (old login tokens)', () => {
    expect(verifySession(jwt.sign({ userId: 'u1' }, config.jwt.secret))).toBeNull();
  });
});

describe('readCookie', () => {
  it('finds the cookie among others and decodes it', () => {
    expect(readCookie(`a=1; ${SESSION_COOKIE}=abc%2Edef; b=2`, SESSION_COOKIE)).toBe('abc.def');
  });

  it('returns null when missing or malformed', () => {
    expect(readCookie(undefined, SESSION_COOKIE)).toBeNull();
    expect(readCookie('a=1; b', SESSION_COOKIE)).toBeNull();
    expect(readCookie(`${SESSION_COOKIE}=%E0%A4%A`, SESSION_COOKIE)).toBeNull();
  });

  it('sessionCookie() builds a Cookie header value', () => {
    expect(sessionCookie({ id: 'u1', tokenVersion: 0 })).toMatch(new RegExp(`^${SESSION_COOKIE}=`));
  });
});
