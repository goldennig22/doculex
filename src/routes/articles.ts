import { FastifyPluginAsync } from 'fastify';
import { ArticleRoute, show } from '../controllers/articles.controller';
import { articlePageRouteSchema } from './schemas/schemas';

// Public: an article and the PUBLISHED decisions citing it (the service filters with searchableDocuments)
export const articleRoutes: FastifyPluginAsync = async (app) => {
  app.get<ArticleRoute>('/:documentId/:articleRef', { schema: articlePageRouteSchema }, show);
};
