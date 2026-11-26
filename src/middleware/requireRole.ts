import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { env } from '../config/env';
import { API_KEY_FORMAT, findActiveKey, hasRole } from '../services/api-keys.service';
import type { Role } from '../interfaces/types';
import { failedResponse } from '../utils/utils';

// Hash both sides so they have equal length (timingSafeEqual throws otherwise)
const digest = (s: string) => createHash('sha256').update(s).digest();
const isLegacyAdminKey = (given: string) => timingSafeEqual(digest(given), digest(env.ADMIN_API_KEY));

/**
 * Register as an `onRequest` hook, never preHandler: @fastify/multipart reads the body in preValidation,
 * so a later hook would buffer a 20 MB upload before the 401, and show validation rules (422) to anonymous clients.
 *
 * 401: no key, an unknown key or a revoked key (authentication: who are you?).
 * 403: a valid key whose role is too low (authorization: you may not do this).
 *
 * `allowLegacyAdmin`: the single ADMIN_API_KEY from .env still works as an admin, until every route is migrated.
 * It has no row in api_keys (req.apiKey.id is null), so routes that record who did what must not allow it.
 */
export function requireRole(need: Role, { allowLegacyAdmin = false }: { allowLegacyAdmin?: boolean } = {}) {
  return async function checkRole(req: FastifyRequest, reply: FastifyReply) {
    const given = req.headers['x-api-key'];
    if (typeof given !== 'string' || given === '') {
      return failedResponse(reply, 401, 'Invalid or missing API key');
    }

    if (allowLegacyAdmin && isLegacyAdminKey(given)) {
      req.apiKey = { id: null, role: 'admin', label: 'legacy ADMIN_API_KEY' };
      return;
    }

    // A malformed key can't exist in the table: rejected without a database round trip
    const identity = API_KEY_FORMAT.test(given) ? await findActiveKey(given) : null;
    if (!identity) return failedResponse(reply, 401, 'Invalid or missing API key');

    if (!hasRole(identity.role, need)) {
      return failedResponse(reply, 403, `This action requires the ${need} role`);
    }
    req.apiKey = identity;
  };
}
