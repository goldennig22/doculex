import { FastifyPluginAsync } from 'fastify';
import { SearchAllRoute, searchAllHandler, statsHandler } from '../controllers/search.controller';
import { decisionStatsRouteSchema, searchAllRouteSchema } from './schemas/schemas';

// Each search with q embeds it: one paid provider call per request
export const SEARCH_RATE_LIMIT = { max: 60, timeWindow: '1 minute' };

// Public: published content only (searchableDocuments, in every query of the search services)
export const searchRoutes: FastifyPluginAsync = async (app) => {
  app.get<SearchAllRoute>('/search', { schema: searchAllRouteSchema, config: { rateLimit: SEARCH_RATE_LIMIT } }, searchAllHandler);
  app.get('/stats', { schema: decisionStatsRouteSchema }, statsHandler);
};
