import { Prisma } from '@prisma/client';

/**
 * Read a Json column that stores string[] (e.g. hashtags).
 * MariaDB has no native array type, so arrays live in JSON columns.
 */
export function toStringArray(value: Prisma.JsonValue | null | undefined): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}
