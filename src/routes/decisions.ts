import { FastifyPluginAsync } from "fastify";
import { create, CreateDecisionRoute } from "../controllers/decisions.controller";
import { requireRole } from "../middleware/requireRole";
import { createDecisionRouteSchema } from "./schemas/schemas";

// Each upload embeds every section (paid calls) and a rejected draft is money spent for nothing
export const DECISION_UPLOAD_RATE_LIMIT = { max: 30, timeWindow: '1 hour' };

export const decisionRoutes: FastifyPluginAsync = async (app) => {
    // onRequest: 401/403 before the multipart body is read (see routes/documents.ts).
    // No legacy ADMIN_API_KEY: a decision records which key contributed it, and the legacy key has no row.
    app.addHook('onRequest', requireRole('contributor'));
    app.post<CreateDecisionRoute>('', {
        schema: createDecisionRouteSchema,
        config: { rateLimit: DECISION_UPLOAD_RATE_LIMIT },
    }, create);
};
