import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import { HealthChecks, healthRoutes } from "./routes/health";
import { checkDatabase, checkLlm } from './services/health.service';
import { env } from './config/env';
import { documentRoutes } from './routes/documents';

export function buildApp(opts: { checks?: HealthChecks } = {}) {
  const app = Fastify({ logger: env.NODE_ENV !== 'test' });
  app.register(multipart, {
    attachFieldsToBody: 'keyValues',   // req.body = { title: '...', file: <Buffer> }
    limits: { fileSize: 20 * 1024 * 1024, files: 1 }, // over 20 MB → 413, before buffering
  });
  app.register((api) => {
    api.register(healthRoutes(opts.checks ?? { database: checkDatabase, llm: checkLlm }));
    api.register(documentRoutes, { prefix: "/documents"});
  }, { prefix: '/api' })
  return app;
}