import { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { successResponse } from "../utils/utils";
import { createDecisionSchema } from "../utils/schemas";
import { ingestDecision } from "../services/decisions.service";

// The body was validated by the route schema (src/routes/schemas/schemas.ts) before the controller runs
export type CreateDecisionRoute = { Body: z.output<typeof createDecisionSchema> };

export const create = async (req: FastifyRequest<CreateDecisionRoute>, reply: FastifyReply) => {
    // requireRole('contributor') ran in onRequest and refuses the legacy key, so an id is always there.
    // If it isn't, the route was wired without it: our bug, a 500, never an anonymous draft.
    const contributorId = req.apiKey?.id;
    if (!contributorId) throw new Error('POST /api/decisions reached the controller without a database API key');

    const decision = await ingestDecision(req.body, contributorId);
    return successResponse(reply, 201, decision);
}
