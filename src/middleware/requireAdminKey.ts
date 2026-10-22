import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { env } from '../config/env';
import { failedResponse } from '../utils/utils';

// Hash both sides so they have equal length (timingSafeEqual throws otherwise)
const digest = (s: string) => createHash('sha256').update(s).digest();

export async function requireAdminKey(req: FastifyRequest, reply: FastifyReply) {
  const given = req.headers['x-api-key'];
  if (typeof given !== 'string' || !timingSafeEqual(digest(given), digest(env.ADMIN_API_KEY))) {
    return failedResponse(reply, 401, 'Invalid or missing API key');
  }
}