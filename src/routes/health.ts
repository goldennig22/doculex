import type { FastifyPluginAsync } from 'fastify';
import type { CheckResult } from '../services/health.service';
import { checkHealth } from '../controllers/health.controller';

export type HealthChecks = {
  database: () => Promise<CheckResult>;
  llm: () => Promise<CheckResult>;
};

export const healthRoutes = (checks: HealthChecks): FastifyPluginAsync => async (app) => {
    app.get('/health', async (_req, reply) => { return await checkHealth(_req, reply, checks) });
};