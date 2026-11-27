import { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { successResponse } from '../utils/utils';
import { decisionSearchQuerySchema, searchAllQuerySchema } from '../utils/schemas';
import { decisionStats, searchDecisions } from '../services/decision-search.service';
import { searchAll } from '../services/search-all.service';

// Query strings are validated, coerced (page, limit, year) and normalised (country, article) by the route schema
export type DecisionSearchRoute = { Querystring: z.output<typeof decisionSearchQuerySchema> };
export type SearchAllRoute = { Querystring: z.output<typeof searchAllQuerySchema> };

export const searchDecisionsHandler = async (req: FastifyRequest<DecisionSearchRoute>, reply: FastifyReply) =>
  successResponse(reply, 200, await searchDecisions(req.query));

export const searchAllHandler = async (req: FastifyRequest<SearchAllRoute>, reply: FastifyReply) =>
  successResponse(reply, 200, await searchAll(req.query.q, req.query.limit));

export const statsHandler = async (_req: FastifyRequest, reply: FastifyReply) =>
  successResponse(reply, 200, await decisionStats());
