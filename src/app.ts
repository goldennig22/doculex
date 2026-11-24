import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import { HealthChecks, healthRoutes } from "./routes/health";
import { checkDatabase, checkLlm } from './services/health.service';
import { env } from './config/env';
import { documentRoutes } from './routes/documents';
import { aiRoutes } from './routes/ai';
import { errorHandler } from './utils/error-handler';
import rateLimit from '@fastify/rate-limit'

export function buildApp(opts: { checks?: HealthChecks } = {}) {
  const app = Fastify({
    logger: env.NODE_ENV !== 'test',
    // Behind Caddy every request comes from 127.0.0.1: trust X-Forwarded-For from the proxy's address only,
    // otherwise all clients share one rate-limit bucket (or, with `true`, anyone can fake their IP).
    trustProxy: env.TRUST_PROXY || false, // unset or empty → trust no proxy
  });
  app.register(multipart, {
    attachFieldsToBody: 'keyValues',   // req.body = { title: '...', file: <Buffer> }
    limits: { fileSize: 20 * 1024 * 1024, files: 1 }, // over 20 MB → 413, before buffering
  });
  app.setErrorHandler(errorHandler);
  // Off by default; a route opts in with `config.rateLimit` (only /ask, which costs LLM tokens).
  // Fixed window per IP, in memory: fine for one process on one VPS.
  app.register(rateLimit, { global: false });
  app.register((api) => {
    api.register(healthRoutes(opts.checks ?? { database: checkDatabase, llm: checkLlm }));
    api.register(documentRoutes, { prefix: "/documents"});
    api.register(aiRoutes, { prefix: "/ai"});
  }, { prefix: '/api' })
  return app;
}