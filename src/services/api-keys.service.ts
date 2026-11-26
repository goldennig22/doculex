import { createHash, randomBytes } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../db/client';
import { apiKeys } from '../db/schema';
import type { ApiKeyIdentity, Role } from '../interfaces/types';

// "dlx_" + 32 random bytes in base64url (43 characters). The prefix lets secret scanners
// (GitLab secret detection) recognise a leaked key, and lets requireRole reject garbage without a query.
const KEY_PREFIX = 'dlx_';
export const API_KEY_FORMAT = /^dlx_[A-Za-z0-9_-]{43}$/;

// Higher rank includes the lower ones: an admin can do what a reviewer can, a reviewer what a contributor can.
const RANK: Record<Role, number> = { contributor: 1, reviewer: 2, admin: 3 };

export const hasRole = (have: Role, need: Role): boolean => RANK[have] >= RANK[need];

/**
 * SHA-256, not bcrypt: the key has 256 random bits, so slowing down guesses adds nothing,
 * and a deterministic hash can be looked up through the unique index (a salted bcrypt hash can't).
 */
export const hashApiKey = (plaintext: string): string => createHash('sha256').update(plaintext).digest('hex');

export function generateApiKey(): { plaintext: string; prefix: string; hash: string } {
  const plaintext = KEY_PREFIX + randomBytes(32).toString('base64url');
  return { plaintext, prefix: plaintext.slice(0, 8), hash: hashApiKey(plaintext) };
}

/** The plaintext is returned once and never stored: print it, then forget it. */
export async function createApiKey(role: Role, label: string): Promise<{ id: string; prefix: string; plaintext: string }> {
  const { plaintext, prefix, hash } = generateApiKey();
  const [row] = await db.insert(apiKeys).values({ keyHash: hash, prefix, role, label }).returning({ id: apiKeys.id });
  return { id: row.id, prefix, plaintext };
}

/** null when the key is unknown or revoked: both are a 401, a revoked key no longer identifies anyone. */
export async function findActiveKey(plaintext: string): Promise<ApiKeyIdentity | null> {
  if (!API_KEY_FORMAT.test(plaintext)) return null;
  const [row] = await db
    .update(apiKeys)
    .set({ lastUsedAt: new Date() })
    .where(and(eq(apiKeys.keyHash, hashApiKey(plaintext)), isNull(apiKeys.revokedAt)))
    .returning({ id: apiKeys.id, role: apiKeys.role, label: apiKeys.label });
  return row ?? null;
}

/** false when no active key has this id. Revoked keys stay in the table: decisions still point at them. */
export async function revokeApiKey(id: string): Promise<boolean> {
  const rows = await db
    .update(apiKeys)
    .set({ revokedAt: new Date() })
    .where(and(eq(apiKeys.id, id), isNull(apiKeys.revokedAt)))
    .returning({ id: apiKeys.id });
  return rows.length > 0;
}
