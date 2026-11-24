import { FastifyReply, FastifyRequest } from "fastify";
import { validate } from "../utils/validate";
import { searchQuestionSchema } from "../utils/schemas";
import { failedResponse, successResponse } from "../utils/utils";
import { askQuestion } from "../services/ask.service";

export const ask = async (req: FastifyRequest, reply: FastifyReply) => {
    const v = validate(searchQuestionSchema, req.body);
    if (!v.ok) return failedResponse(reply, 422, 'Validation failed', v.errors);
    const data = await askQuestion(v.data.question);
    return successResponse(reply, 200, data);
}