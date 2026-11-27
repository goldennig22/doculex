import { FastifyPluginAsync, FastifyRequest } from "fastify";
import {
    create, CreateDecisionRoute, DecisionIdRoute, publish, queue, report, ReportDecisionRoute, review, ReviewDecisionRoute,
    show,
} from "../controllers/decisions.controller";
import { DecisionSearchRoute, searchDecisionsHandler } from "../controllers/search.controller";
import { requireRole } from "../middleware/requireRole";
import {
    createDecisionRouteSchema, publishDecisionRouteSchema, reportDecisionRouteSchema, reviewDecisionRouteSchema,
    reviewQueueRouteSchema, searchDecisionsRouteSchema, showDecisionRouteSchema,
} from "./schemas/schemas";
import { SEARCH_RATE_LIMIT } from "./search";

// Each upload embeds every section (paid calls) and a rejected draft is money spent for nothing.
// Counted per API KEY, not per IP: a leaked key used from many addresses still gets 30. requireRole runs first
// (an instance onRequest hook; the rate limit is appended to the route's own onRequest), so req.apiKey is set.
export const DECISION_UPLOAD_RATE_LIMIT = {
    max: 30,
    timeWindow: '1 hour',
    keyGenerator: (req: FastifyRequest) => req.apiKey?.id ?? req.ip,
};

// The only public write. Low: a person reports one decision, not dozens; the daily breaker
// (decision-report.service.ts) is what stops someone with many addresses.
export const REPORT_RATE_LIMIT = { max: 5, timeWindow: '1 hour' };
const REPORT_BODY_LIMIT = 4096; // a reason, 2000 characters of message and an address, with room to spare

// onRequest: 401/403 before the body is read (multipart for uploads, see routes/documents.ts), and before 422.
// No legacy ADMIN_API_KEY: every action on a decision records which key did it, and the legacy key has no row.
export const decisionRoutes: FastifyPluginAsync = async (app) => {
    // Public, no key: published decisions only (decision-search.service.ts). GET /:decisionId stays reviewer-only:
    // it shows drafts, captions and clear names.
    app.get<DecisionSearchRoute>('', {
        schema: searchDecisionsRouteSchema,
        config: { rateLimit: SEARCH_RATE_LIMIT },
    }, searchDecisionsHandler);
    // Public, no key: 404 unless published (decision-report.service.ts)
    app.post<ReportDecisionRoute>('/:decisionId/report', {
        schema: reportDecisionRouteSchema,
        bodyLimit: REPORT_BODY_LIMIT,
        config: { rateLimit: REPORT_RATE_LIMIT },
    }, report);
    app.register(async (contributor) => {
        contributor.addHook('onRequest', requireRole('contributor'));
        contributor.post<CreateDecisionRoute>('', {
            schema: createDecisionRouteSchema,
            config: { rateLimit: DECISION_UPLOAD_RATE_LIMIT },
        }, create);
    });
    app.register(async (reviewer) => {
        reviewer.addHook('onRequest', requireRole('reviewer'));
        // A static segment: Fastify matches it before /:decisionId
        reviewer.get('/queue', { schema: reviewQueueRouteSchema }, queue);
        reviewer.get<DecisionIdRoute>('/:decisionId', { schema: showDecisionRouteSchema }, show);
        reviewer.patch<ReviewDecisionRoute>('/:decisionId', { schema: reviewDecisionRouteSchema }, review);
        reviewer.post<DecisionIdRoute>('/:decisionId/publish', { schema: publishDecisionRouteSchema }, publish);
    });
};
