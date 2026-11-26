import type { ApiKeyIdentity } from './types';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by requireRole on protected routes; null everywhere else. */
    apiKey: ApiKeyIdentity | null;
  }
}
