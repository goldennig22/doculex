import Fastify from 'fastify';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import multipart from '@fastify/multipart';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { HealthChecks, healthRoutes } from "./routes/health";
import { checkDatabase, checkLlm } from './services/health.service';
import { env } from './config/env';
import { documentRoutes } from './routes/documents';
import { aiRoutes } from './routes/ai';
import { decisionRoutes } from './routes/decisions';
import { articleRoutes } from './routes/articles';
import { errorHandler } from './utils/error-handler';
import { zodSerializerCompiler, zodToJsonSchemaTransform, zodValidatorCompiler } from './utils/zod-fastify';
import rateLimit from '@fastify/rate-limit'

// Read once at startup: the page is static, and a missing file should fail the boot, not the first visitor
const demoPage = readFileSync(join(process.cwd(), 'public', 'index.html'), 'utf8');

export function buildApp(opts: { checks?: HealthChecks } = {}) {
  const app = Fastify({
    logger: env.NODE_ENV !== 'test',
    // Behind nginx every request comes from the proxy (the Docker gateway in production): trust X-Forwarded-For from its address only,
    // otherwise all clients share one rate-limit bucket (or, with `true`, anyone can fake their IP).
    trustProxy: env.TRUST_PROXY || false, // unset or empty → trust no proxy
  });
  // Route schemas are Zod objects: requests are validated and responses checked with Zod (see zod-fastify.ts)
  app.setValidatorCompiler(zodValidatorCompiler);
  app.setSerializerCompiler(zodSerializerCompiler);
  app.register(multipart, {
    attachFieldsToBody: 'keyValues',   // req.body = { title: '...', file: <Buffer> }
    limits: { fileSize: 20 * 1024 * 1024, files: 1 }, // over 20 MB → 413, before buffering
  });
  app.setErrorHandler(errorHandler);
  // Filled by requireRole on protected routes. Declared up front so every request object has the same shape.
  app.decorateRequest('apiKey', null);
  // Off by default; a route opts in with `config.rateLimit` (only /ask, which costs LLM tokens).
  // Fixed window per IP, in memory: fine for one process on one VPS.
  app.register(rateLimit, { global: false });
  // Before the routes: @fastify/swagger collects them with an onRoute hook, so it only sees routes registered after it
  app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'DocuLex API',
        version: '1.0.0',
        description: 'Questions in French or English about OHADA business law, answered with citations to the exact article and pages. '
          + 'Every response is `{ status: "success", data }` or `{ status: "failed", message, errors?, requestId? }`.',
      },
      tags: [
        { name: 'ask', description: 'Cited answers' },
        { name: 'documents', description: 'The ingested Uniform Acts' },
        { name: 'decisions', description: 'Court decisions: contributed as drafts, searchable once a reviewer publishes them' },
        { name: 'articles', description: 'Annotated code: an article and the published decisions that cite it' },
        { name: 'health', description: 'Service status' },
      ],
      components: {
        securitySchemes: {
          adminKey: { type: 'apiKey', in: 'header', name: 'x-api-key', description: 'An admin key (or the legacy ADMIN_API_KEY)' },
          apiKey: { type: 'apiKey', in: 'header', name: 'x-api-key', description: 'A key created with npm run keys:create; its role decides what it may do' },
        },
      },
    },
    transform: zodToJsonSchemaTransform,
  });
  app.register(swaggerUi, { routePrefix: '/docs' });
  app.get('/', { schema: { hide: true } }, (req, reply) => reply.type('text/html; charset=utf-8').send(demoPage));
  app.register((api) => {
    api.register(healthRoutes(opts.checks ?? { database: checkDatabase, llm: checkLlm }));
    api.register(documentRoutes, { prefix: "/documents"});
    api.register(aiRoutes, { prefix: "/ai"});
    api.register(decisionRoutes, { prefix: '/decisions' });
    api.register(articleRoutes, { prefix: '/articles' });
  }, { prefix: '/api' })
  return app;
}
