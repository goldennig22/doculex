import { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { failedResponse, successResponse } from '../utils/utils';
import { articleParamsSchema } from '../utils/schemas';
import { getArticlePage } from '../services/articles.service';

// Params are validated and the article ref normalised ("1er" → "1") by the route schema before this runs
export type ArticleRoute = { Params: z.output<typeof articleParamsSchema> };

export const show = async (req: FastifyRequest<ArticleRoute>, reply: FastifyReply) => {
  const page = await getArticlePage(req.params.documentId, req.params.articleRef);
  if (!page) return failedResponse(reply, 404, 'Article not found');
  return successResponse(reply, 200, page);
};
