import bcrypt from 'bcryptjs';
import { z } from 'zod';

export const BCRYPT_COST = 12;

export const normalizeEmail = (email: string) => email.trim().toLowerCase();

/** Passwords are set by the admin (create / edit member). */
export const passwordSchema = z.string().min(8, 'Mật khẩu cần ít nhất 8 ký tự.').max(200);

export const hashPassword = (password: string) => bcrypt.hash(password, BCRYPT_COST);

/** False for missing or placeholder hashes (e.g. the old bypass user's "dummy"). */
export async function verifyPassword(password: string, hash: string | null | undefined): Promise<boolean> {
  if (!hash || !hash.startsWith('$2')) return false;
  return bcrypt.compare(password, hash);
}
