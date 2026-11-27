import { FastifyPluginAsync } from "fastify";
import { deleteDocument, DocumentIdRoute, list, show, upload, UploadRoute } from "../controllers/documents.controller";
import { requireRole } from "../middleware/requireRole";
import { deleteDocumentSchema, listDocumentsSchema, showDocumentSchema, uploadDocumentRouteSchema } from "./schemas/schemas";

export const documentRoutes: FastifyPluginAsync = async (app) => {
    app.get('', { schema: listDocumentsSchema }, list);
    app.get<DocumentIdRoute>('/:documentId/show', { schema: showDocumentSchema }, show);
    app.register(async (admin) => {
        // onRequest, not preHandler: @fastify/multipart reads the parts in preValidation,
        // so a later hook would let anyone make the server buffer a 20 MB upload before the 401.
        // It also keeps the order 401 before 422: an anonymous client never sees the validation rules.
        // Statutes are admin-only. The legacy ADMIN_API_KEY still works here until it is retired.
        admin.addHook('onRequest', requireRole('admin', { allowLegacyAdmin: true }));
        admin.post<UploadRoute>('/upload', { schema: uploadDocumentRouteSchema }, upload);
        admin.delete<DocumentIdRoute>('/:documentId/delete', { schema: deleteDocumentSchema }, deleteDocument);
    });
};
