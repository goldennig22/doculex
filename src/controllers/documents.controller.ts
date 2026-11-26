import { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { failedResponse, successResponse } from "../utils/utils";
import { documentIdSchema, uploadDocumentSchema } from "../utils/schemas";
import { getDocuments, ingestDocument, deleteDocument as deleteServiceDocument } from "../services/documents.service";

// Bodies and params are validated by the route schemas (src/routes/schemas/schemas.ts) before a controller runs
export type UploadRoute = { Body: z.infer<typeof uploadDocumentSchema> };
export type DocumentIdRoute = { Params: z.infer<typeof documentIdSchema> };

export const upload = async (req: FastifyRequest<UploadRoute>, reply: FastifyReply) => {
    // upload file to local/project storage (can create a service if necessary)
    const result = await ingestDocument(req.body);
    const document = await getDocuments(result.documentId);
    return successResponse(reply, 201, document);
}

export const list = async (req: FastifyRequest, reply: FastifyReply) => {
    const data = await getDocuments();
    return successResponse(reply, 200, data);
}

export const show = async (req: FastifyRequest<DocumentIdRoute>, reply: FastifyReply) => {
    const data = await getDocuments(req.params.documentId);
    if (!data) return failedResponse(reply, 404, 'Document not found');
    return successResponse(reply, 200, data);
}

export const update = async (req: FastifyRequest, reply: FastifyReply) => {
    return successResponse(reply, 200, {});
}

export const deleteDocument = async (req: FastifyRequest<DocumentIdRoute>, reply: FastifyReply) => {
    // The uuid check ran in the route schema: "abc" gets a 422 and never reaches Postgres (where it would be a 500)
    const deleted = await deleteServiceDocument(req.params.documentId);
    if (!deleted) return failedResponse(reply, 404, 'Document not found');
    return successResponse(reply, 200, { documentId: req.params.documentId });
}
