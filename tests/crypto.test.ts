import { describe, it, expect, beforeEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import { encrypt, decrypt, isEncrypted, mask } from '../src/lib/crypto';

describe('crypto', () => {
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = randomBytes(32).toString('base64');
  });

  it('round-trips unicode secrets', () => {
    const secret = 'EAAtoken-Tiếng Việt-🔐';
    const payload = encrypt(secret);
    expect(payload).not.toContain(secret);
    expect(payload.split(':')).toHaveLength(3);
    expect(decrypt(payload)).toBe(secret);
  });

  it('uses a random IV (same input → different ciphertext)', () => {
    expect(encrypt('abc')).not.toBe(encrypt('abc'));
  });

  it('rejects tampered ciphertext', () => {
    const [iv, tag, ct] = encrypt('secret-value').split(':');
    const flipped = Buffer.from(ct, 'base64');
    flipped[0] ^= 0xff;
    expect(() => decrypt([iv, tag, flipped.toString('base64')].join(':'))).toThrow();
  });

  it('fails with a different key', () => {
    const payload = encrypt('secret-value');
    process.env.ENCRYPTION_KEY = randomBytes(32).toString('base64');
    expect(() => decrypt(payload)).toThrow();
  });

  it('requires a 32-byte base64 key', () => {
    process.env.ENCRYPTION_KEY = Buffer.from('too-short').toString('base64');
    expect(() => encrypt('x')).toThrow(/32 bytes/);
    delete process.env.ENCRYPTION_KEY;
    expect(() => encrypt('x')).toThrow(/not set/);
  });

  it('detects encrypted payloads', () => {
    expect(isEncrypted(encrypt('x'))).toBe(true);
    expect(isEncrypted('EAAplainToken123')).toBe(false);
  });

  it('masks to last 4 chars', () => {
    expect(mask('abcdefgh1234')).toBe('••••••1234');
    expect(mask('abc')).toBe('••••••');
    expect(mask('')).toBe('');
    expect(mask(null)).toBe('');
  });
});
