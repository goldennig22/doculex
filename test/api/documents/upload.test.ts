// test/api/documents/upload.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import formAutoContent from 'form-auto-content';
import { buildApp } from '../../../src/app';
import { env } from '../../../src/config/env';
import { getDocuments, ingestDocument } from '../../../src/services/documents.service';
import { findActiveKey, generateApiKey } from '../../../src/services/api-keys.service';

// Route tests never touch Postgres, the PDF parser or Voyage: the service is mocked.
// Everything else in the module stays real (importOriginal).
vi.mock('../../../src/services/documents.service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/services/documents.service')>()),
  ingestDocument: vi.fn(),
  getDocuments: vi.fn(),
}));

// Database keys: the lookup is mocked, everything else in requireRole is real
vi.mock('../../../src/services/api-keys.service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/services/api-keys.service')>()),
  findActiveKey: vi.fn(),
}));

const URL = '/api/documents/upload';
// A real uuid: the response schema checks it, as Postgres would only ever return one
const DOC_ID = 'c9725d5d-0bc8-46aa-b8f8-cfa870d6425c';
const fakePdf = Buffer.from('%PDF-1.4\n% test fixture\n'); // passes the "%PDF-" magic-byte check
const file = (value: Buffer, filename = 'act.pdf', contentType = 'application/pdf') => ({
  value,
  options: { filename, contentType },
});
const validFields = () => ({ title: 'AUDCG 2010', language: 'fr', actCode: 'AUDCG', actVersion: '2010', file: file(fakePdf) });

/** Builds a real multipart/form-data request; apiKey null = no header at all. */
function upload(fields: Record<string, unknown>, apiKey: string | null = env.ADMIN_API_KEY) {
  const form = formAutoContent(fields);
  return app.inject({
    method: 'POST',
    url: URL,
    payload: form.payload,
    headers: { ...form.headers, ...(apiKey ? { 'x-api-key': apiKey } : {}) },
  });
}

let app: FastifyInstance;

beforeAll(async () => {
  app = buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  vi.clearAllMocks(); // each test sets up its own mock results
});

describe('POST /api/documents/upload', () => {
  it('returns 401 without an API key, before reading the body', async () => {
    const res = await upload(validFields(), null);
    expect(res.statusCode).toBe(401);
    expect(res.json().status).toBe('failed');
    expect(ingestDocument).not.toHaveBeenCalled();
  });

  // Proves the order, not just the status: a body the multipart parser would reject still gets 401,
  // so the key is checked before a single byte of the body is parsed or buffered
  it('checks the API key before parsing the multipart body', async () => {
    const res = await app.inject({
      method: 'POST',
      url: URL,
      payload: 'this is not multipart',
      headers: { 'content-type': 'multipart/form-data; boundary=----nope' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns 401 with a wrong API key', async () => {
    const res = await upload(validFields(), 'not-the-admin-key-not-the-admin-key');
    expect(res.statusCode).toBe(401);
  });

  // it('returns 422 when the file is missing', async () => {
  //   const res = await upload({ title: 'AUDCG 2010', language: 'fr' });
  //   expect(res.statusCode).toBe(422);
  //   expect(res.json().errors.file).toBeDefined();
  //   expect(ingestDocument).not.toHaveBeenCalled();
  // });

  // Authorization: the key is valid, its role is too low. Statutes are admin-only.
  it.each(['reviewer', 'contributor'] as const)('returns 403 for a valid %s key', async (role) => {
    vi.mocked(findActiveKey).mockResolvedValueOnce({ id: DOC_ID, role, label: `${role}-1` });
    const res = await upload(validFields(), generateApiKey().plaintext);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ status: 'failed', message: 'This action requires the admin role' });
    expect(ingestDocument).not.toHaveBeenCalled();
  });

  it('accepts an admin key from the database, not only the legacy ADMIN_API_KEY', async () => {
    vi.mocked(findActiveKey).mockResolvedValueOnce({ id: DOC_ID, role: 'admin', label: 'admin-1' });
    vi.mocked(ingestDocument).mockResolvedValueOnce({ documentId: DOC_ID, chunkCount: 1 });
    vi.mocked(getDocuments).mockResolvedValueOnce({
      id: DOC_ID, kind: 'statute', title: 'AUDCG 2010', language: 'fr', sourceUrl: null, pageCount: 66, actCode: null, actVersion: null, createdAt: new Date(),
    });
    const res = await upload(validFields(), generateApiKey().plaintext);
    expect(res.statusCode).toBe(201);
  });

  it('returns 422 when the file is not a real PDF', async () => {
    const res = await upload({ ...validFields(), file: file(Buffer.from('hello'), 'fake.pdf') });
    expect(res.statusCode).toBe(422);
    expect(res.json().errors.file).toBeDefined();
  });

  it('returns 422 when the language is not fr or en', async () => {
    const res = await upload({ ...validFields(), language: 'de' });
    expect(res.statusCode).toBe(422);
    expect(res.json().errors.language).toBeDefined();
  });

  // A statute without its act links to no decision, and nothing says so: refused at the door instead
  it('returns 422 when actCode and actVersion are missing', async () => {
    const res = await upload({ title: 'AUDCG 2010', language: 'fr', file: file(fakePdf) });
    expect(res.statusCode).toBe(422);
    expect(res.json().errors.actCode).toBeDefined();
    expect(ingestDocument).not.toHaveBeenCalled();
  });

  it('returns 422 for a version the act does not have', async () => {
    const res = await upload({ ...validFields(), actVersion: '2011' });
    expect(res.statusCode).toBe(422);
    expect(res.json().errors.actVersion).toBeDefined();
    expect(ingestDocument).not.toHaveBeenCalled();
  });

  it('returns 413 when the file is over 20 MB', async () => {
    const big = Buffer.concat([fakePdf, Buffer.alloc(21 * 1024 * 1024)]);
    const res = await upload({ ...validFields(), file: file(big) });
    expect(res.statusCode).toBe(413);
  });

  it('returns 201 with the stored document', async () => {
    vi.mocked(ingestDocument).mockResolvedValueOnce({ documentId: DOC_ID, chunkCount: 42 });
    vi.mocked(getDocuments).mockResolvedValueOnce({
      id: DOC_ID,
      kind: 'statute',
      title: 'AUDCG 2010',
      language: 'fr',
      sourceUrl: null,
      pageCount: 66,
      actCode: 'AUDCG',
      actVersion: '2010',
      createdAt: new Date('2026-10-28T10:00:00Z'),
    });

    const res = await upload(validFields());

    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({
      status: 'success',
      data: {
        id: DOC_ID,
        kind: 'statute',
        title: 'AUDCG 2010',
        language: 'fr',
        sourceUrl: null,
        pageCount: 66,
        actCode: 'AUDCG',
        actVersion: '2010',
        createdAt: '2026-10-28T10:00:00.000Z', // a Date becomes an ISO string in JSON
      },
    });
    // The controller passed the validated fields and the file bytes to the service
    expect(ingestDocument).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'AUDCG 2010', language: 'fr', actCode: 'AUDCG', actVersion: '2010', file: expect.any(Buffer) }),
    );
  });

  it('returns 500 without leaking internals when ingestion fails', async () => {
    vi.mocked(ingestDocument).mockRejectedValueOnce(new Error('insert into "chunks" … failed'));

    const res = await upload(validFields());

    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ status: 'failed', message: 'Internal server error', requestId: expect.any(String) });
    expect(res.body).not.toContain('insert into');
  });
});