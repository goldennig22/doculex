import { FastifyPluginAsync } from "fastify";
import { ask } from "../controllers/ai.controller";

export const ASK_RATE_LIMIT = { max: 10, timeWindow: '1 minute' };

export const aiRoutes: FastifyPluginAsync = async (app) => {
    // Every request counts, even an invalid one: the limit runs in onRequest, before validation
    app.post('/ask', { config: { rateLimit: ASK_RATE_LIMIT } }, ask);
};
