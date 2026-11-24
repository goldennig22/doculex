import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../../src/app';
import { env } from '../../../src/config/env';
import { deleteDocument } from '../../../src/services/documents.service';

vi.mock('../../../src/services/documents.service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/services/documents.service')>()),
  deleteDocument: vi.fn(),
}));

const ID = '3f6c1e0a-8b2d-4c7e-9a51-2d4b6e8f0a13';
let app: FastifyInstance;
const del = (id: string) =>
  app.inject({ method: 'DELETE', url: `/api/documents/${id}/delete`, headers: { 'x-api-key': env.ADMIN_API_KEY } });

beforeAll(async () => {
  app = buildApp();
  await app.ready();
});
afterAll(async () => {
  await app.close();
});
beforeEach(() => {
  vi.clearAllMocks();
});

describe('DELETE /api/documents/:documentId/delete', () => {
  it('returns 422 for an id that is not a uuid, without querying Postgres', async () => {
    const res = await del('abc');
    expect(res.statusCode).toBe(422);
    expect(deleteDocument).not.toHaveBeenCalled();
  });

  it('returns 404 when no document has this id', async () => {
    vi.mocked(deleteDocument).mockResolvedValueOnce(false);
    const res = await del(ID);
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ status: 'failed', message: 'Document not found' });
  });

  it('returns 200 with the deleted id', async () => {
    vi.mocked(deleteDocument).mockResolvedValueOnce(true);
    const res = await del(ID);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'success', data: { documentId: ID } });
    expect(deleteDocument).toHaveBeenCalledWith(ID);
  });
});
