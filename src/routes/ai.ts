import { FastifyPluginAsync } from "fastify";
import { ask, AskRoute } from "../controllers/ai.controller";
import { askSchema } from "./schemas/schemas";

export const ASK_RATE_LIMIT = { max: 10, timeWindow: '1 minute' };

export const aiRoutes: FastifyPluginAsync = async (app) => {
    // Every request counts, even an invalid one: the limit runs in onRequest, before validation
    app.post<AskRoute>('/ask', { schema: askSchema, config: { rateLimit: ASK_RATE_LIMIT } }, ask);
};
