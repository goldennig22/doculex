import { FastifyPluginAsync } from "fastify";
import { ask, deleteDocument, list, show, update, upload } from "../controllers/documents.controller";
import { requireAdminKey } from "../middleware/requireAdminKey";

export const documentRoutes: FastifyPluginAsync = async (app) => {
    app.get('', list);
    app.get('/:documentId/show', show);
    app.post('/questions/ask', ask);
    app.register(async (admin) => {
        admin.addHook('preHandler', requireAdminKey);
        admin.post('/upload', upload);
        admin.post('/:documentId/update', update);
        admin.delete('/:documentId/delete', deleteDocument);
    });
};