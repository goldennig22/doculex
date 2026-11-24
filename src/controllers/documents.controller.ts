import { FastifyReply, FastifyRequest } from "fastify";
import { failedResponse, successResponse } from "../utils/utils";
import { validate } from "../utils/validate";
import { documentIdSchema, uploadDocumentSchema } from "../utils/schemas";
import { getDocuments, ingestDocument, deleteDocument as deleteServiceDocument } from "../services/documents.service";
import { ShowDocumentInput } from "../interfaces/types";



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
    // "abc" would reach Postgres as an invalid uuid and come back as a 500: reject it here
    const v = validate(documentIdSchema, req.params);
    if (!v.ok) return failedResponse(reply, 422, 'Validation failed', v.errors);
    const deleted = await deleteServiceDocument(v.data.documentId);
    if (!deleted) return failedResponse(reply, 404, 'Document not found');
    return successResponse(reply, 200, { documentId: v.data.documentId });
}

