import { describe, it, expect, vi } from 'vitest';
import type { Request, Response } from 'express';
import { basicAuthGate } from '../src/middleware/basic-auth.middleware';

const basic = (user: string, pass: string) => `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;

function run(gate: ReturnType<typeof basicAuthGate>, path: string, authorization?: string) {
  const res = { setHeader: vi.fn(), status: vi.fn().mockReturnThis(), send: vi.fn() };
  const next = vi.fn();
  gate!({ path, headers: { authorization } } as unknown as Request, res as unknown as Response, next);
  return { res, next };
}

describe('basicAuthGate', () => {
  it('is disabled unless both user and password are set', () => {
    expect(basicAuthGate(undefined, 'x')).toBeNull();
    expect(basicAuthGate('admin', '')).toBeNull();
  });

  const gate = basicAuthGate('admin', 'p:ss word');

  it('lets correct credentials through (password may contain ":")', () => {
    expect(run(gate, '/api/posts', basic('admin', 'p:ss word')).next).toHaveBeenCalled();
  });

  it('rejects missing or wrong credentials with a browser prompt', () => {
    for (const auth of [undefined, basic('admin', 'wrong'), basic('other', 'p:ss word'), 'Bearer abc']) {
      const { res, next } = run(gate, '/', auth);
      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.setHeader).toHaveBeenCalledWith('WWW-Authenticate', expect.stringContaining('Basic'));
    }
  });

  it('keeps /health open for uptime monitors', () => {
    expect(run(gate, '/health').next).toHaveBeenCalled();
  });
});
