import { FastifyReply, FastifyRequest } from "fastify";
import z from "zod";
import { failedResponse, successResponse } from "../utils/utils";
import { validate } from "../utils/validate";
import { uploadDocumentSchema } from "../utils/schemas";
import { getDocuments, ingestDocument, deleteDocument as deleteServiceDocument } from "../services/documents.service";



export const upload = async (_req: FastifyRequest, reply: FastifyReply) => {
    const v = validate(uploadDocumentSchema, _req.body);
    if (!v.ok) return failedResponse(reply, 422, 'Validation failed', v.errors);
    // upload file to local/project storage (can create a service if necessary)
    const result = await ingestDocument(v.data)
    .catch((err) => {
        return failedResponse(reply, 500, "Failte do Upload document", err)
    });
    return successResponse(reply, 201, result);
}

export const list = async (_req: FastifyRequest, reply: FastifyReply) => {
    const data = await getDocuments();
    return successResponse(reply, 200, data);
}

export const show = async (_req: FastifyRequest, reply: FastifyReply) => {
    const data = await getDocuments((_req.params as any).documentId);
    return successResponse(reply, 200, data);
}

export const update = async (_req: FastifyRequest, reply: FastifyReply) => {

}

export const deleteDocument = async (_req: FastifyRequest, reply: FastifyReply) => {
    const data = await deleteServiceDocument((_req.params as any).documentId);
    return successResponse(reply, 200, data);
}

