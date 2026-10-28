import { FastifyReply, FastifyRequest } from "fastify";
import { failedResponse, successResponse } from "../utils/utils";
import { validate } from "../utils/validate";
import { searchQuestionSchema, uploadDocumentSchema } from "../utils/schemas";
import { getDocuments, ingestDocument, deleteDocument as deleteServiceDocument } from "../services/documents.service";
import { ShowDocumentInput } from "../interfaces/documents";
import { searchByVector } from "../services/search.service";



export const upload = async (req: FastifyRequest, reply: FastifyReply) => {
    const v = validate(uploadDocumentSchema, req.body);
    if (!v.ok) return failedResponse(reply, 422, 'Validation failed', v.errors);
    // upload file to local/project storage (can create a service if necessary)
    const result = await ingestDocument(v.data);
    const document = await getDocuments(result.documentId);
    return successResponse(reply, 201, document);
}

export const list = async (req: FastifyRequest, reply: FastifyReply) => {
    const data = await getDocuments();
    return successResponse(reply, 200, data);
}

export const show = async (req: FastifyRequest, reply: FastifyReply) => {
    const data = await getDocuments((req.params as ShowDocumentInput).documentId);
    return successResponse(reply, 200, data);
}

export const update = async (req: FastifyRequest, reply: FastifyReply) => {
    return successResponse(reply, 200, {});
}

export const deleteDocument = async (req: FastifyRequest, reply: FastifyReply) => {
    const data = await deleteServiceDocument((req.params as ShowDocumentInput).documentId);
    return successResponse(reply, 200, data);
}

export const ask = async (req: FastifyRequest, reply: FastifyReply) => {
    const v = validate(searchQuestionSchema, req.body);
    if (!v.ok) return failedResponse(reply, 422, 'Validation failed', v.errors);
    const data = await searchByVector(v.data.question);
    return successResponse(reply, 200, data);
}

