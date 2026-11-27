import { FastifyPluginAsync } from "fastify";
import {
    create, CreateDecisionRoute, DecisionIdRoute, publish, review, ReviewDecisionRoute, show,
} from "../controllers/decisions.controller";
import { requireRole } from "../middleware/requireRole";
import {
    createDecisionRouteSchema, publishDecisionRouteSchema, reviewDecisionRouteSchema, showDecisionRouteSchema,
} from "./schemas/schemas";

// Each upload embeds every section (paid calls) and a rejected draft is money spent for nothing
export const DECISION_UPLOAD_RATE_LIMIT = { max: 30, timeWindow: '1 hour' };

// onRequest: 401/403 before the body is read (multipart for uploads, see routes/documents.ts), and before 422.
// No legacy ADMIN_API_KEY: every action on a decision records which key did it, and the legacy key has no row.
export const decisionRoutes: FastifyPluginAsync = async (app) => {
    app.register(async (contributor) => {
        contributor.addHook('onRequest', requireRole('contributor'));
        contributor.post<CreateDecisionRoute>('', {
            schema: createDecisionRouteSchema,
            config: { rateLimit: DECISION_UPLOAD_RATE_LIMIT },
        }, create);
    });
    app.register(async (reviewer) => {
        reviewer.addHook('onRequest', requireRole('reviewer'));
        reviewer.get<DecisionIdRoute>('/:decisionId', { schema: showDecisionRouteSchema }, show);
        reviewer.patch<ReviewDecisionRoute>('/:decisionId', { schema: reviewDecisionRouteSchema }, review);
        reviewer.post<DecisionIdRoute>('/:decisionId/publish', { schema: publishDecisionRouteSchema }, publish);
    });
};
