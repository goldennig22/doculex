import Fastify from 'fastify';
import { HealthChecks, healthRoutes } from "./routes/health";
import { checkDatabase, checkLlm } from './services/health';
import { env } from './config/env';

export function buildApp(opts: { checks?: HealthChecks } = {}) {
  const app = Fastify({ logger: env.NODE_ENV !== 'test' });
  app.register(healthRoutes(opts.checks ?? { database: checkDatabase, llm: checkLlm }));
  return app;
}