import { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { searchQuestionSchema } from "../utils/schemas";
import { successResponse } from "../utils/utils";
import { askQuestion } from "../services/ask.service";

// The route's schema has already validated the body (422 otherwise), so it arrives parsed and typed
export type AskRoute = { Body: z.infer<typeof searchQuestionSchema> };

export const ask = async (req: FastifyRequest<AskRoute>, reply: FastifyReply) => {
    const data = await askQuestion(req.body.question);
    return successResponse(reply, 200, data);
}
