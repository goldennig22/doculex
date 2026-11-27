import { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { successResponse } from "../utils/utils";
import { createDecisionSchema, decisionIdSchema, reportDecisionSchema, reviewPatchSchema } from "../utils/schemas";
import { ingestDecision } from "../services/decisions.service";
import { getForReview, listReviewQueue, publishDecision, reviewDecision } from "../services/decision-review.service";
import { reportDecision } from "../services/decision-report.service";

// The body was validated by the route schema (src/routes/schemas/schemas.ts) before the controller runs
export type CreateDecisionRoute = { Body: z.output<typeof createDecisionSchema> };
export type DecisionIdRoute = { Params: z.output<typeof decisionIdSchema> };
export type ReviewDecisionRoute = DecisionIdRoute & { Body: z.output<typeof reviewPatchSchema> };

/**
 * requireRole ran in onRequest and refuses the legacy key, so a database key id is always there.
 * If it isn't, the route was wired without it: our bug, a 500, never an anonymous action.
 */
function keyId(req: FastifyRequest): string {
    const id = req.apiKey?.id;
    if (!id) throw new Error(`${req.method} ${req.routeOptions.url} reached the controller without a database API key`);
    return id;
}

export const create = async (req: FastifyRequest<CreateDecisionRoute>, reply: FastifyReply) => {
    const decision = await ingestDecision(req.body, keyId(req));
    return successResponse(reply, 201, decision);
}

export const show = async (req: FastifyRequest<DecisionIdRoute>, reply: FastifyReply) => {
    return successResponse(reply, 200, await getForReview(req.params.decisionId));
}

export const review = async (req: FastifyRequest<ReviewDecisionRoute>, reply: FastifyReply) => {
    return successResponse(reply, 200, await reviewDecision(req.params.decisionId, keyId(req), req.body));
}

export const publish = async (req: FastifyRequest<DecisionIdRoute>, reply: FastifyReply) => {
    return successResponse(reply, 200, await publishDecision(req.params.decisionId, keyId(req)));
}

export type ReportDecisionRoute = DecisionIdRoute & { Body: z.output<typeof reportDecisionSchema> };

/** Public. 202 and the same body whether or not the decision was taken down: the reporter can't probe the breaker. */
export const report = async (req: FastifyRequest<ReportDecisionRoute>, reply: FastifyReply) => {
    const { reportId } = await reportDecision(req.params.decisionId, req.body);
    return successResponse(reply, 202, { reportId });
}

export const queue = async (req: FastifyRequest, reply: FastifyReply) => {
    return successResponse(reply, 200, await listReviewQueue(keyId(req)));
}
