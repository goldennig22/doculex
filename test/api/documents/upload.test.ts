// test/api/documents/upload.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import formAutoContent from 'form-auto-content';
import { buildApp } from '../../../src/app';
import { env } from '../../../src/config/env';
import { getDocuments, ingestDocument } from '../../../src/services/documents.service';

// Route tests never touch Postgres, the PDF parser or Voyage: the service is mocked.
// Everything else in the module stays real (importOriginal).
vi.mock('../../../src/services/documents.service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/services/documents.service')>()),
  ingestDocument: vi.fn(),
  getDocuments: vi.fn(),
}));

const URL = '/api/documents/upload';
const fakePdf = Buffer.from('%PDF-1.4\n% test fixture\n'); // passes the "%PDF-" magic-byte check
const file = (value: Buffer, filename = 'act.pdf', contentType = 'application/pdf') => ({
  value,
  options: { filename, contentType },
});
const validFields = () => ({ title: 'AUDCG 2010', language: 'fr', file: file(fakePdf) });

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

  it('returns 413 when the file is over 20 MB', async () => {
    const big = Buffer.concat([fakePdf, Buffer.alloc(21 * 1024 * 1024)]);
    const res = await upload({ ...validFields(), file: file(big) });
    expect(res.statusCode).toBe(413);
  });

  it('returns 201 with the stored document', async () => {
    vi.mocked(ingestDocument).mockResolvedValueOnce({ documentId: 'doc-1', chunkCount: 42 });
    vi.mocked(getDocuments).mockResolvedValueOnce({
      id: 'doc-1',
      kind: 'statute',
      title: 'AUDCG 2010',
      language: 'fr',
      sourceUrl: null,
      pageCount: 66,
      createdAt: new Date('2026-10-28T10:00:00Z'),
    });

    const res = await upload(validFields());

    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({
      status: 'success',
      data: {
        id: 'doc-1',
        kind: 'statute',
        title: 'AUDCG 2010',
        language: 'fr',
        sourceUrl: null,
        pageCount: 66,
        createdAt: '2026-10-28T10:00:00.000Z', // a Date becomes an ISO string in JSON
      },
    });
    // The controller passed the validated fields and the file bytes to the service
    expect(ingestDocument).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'AUDCG 2010', language: 'fr', file: expect.any(Buffer) }),
    );
  });

  // it('returns 500 without leaking internals when ingestion fails', async () => {
  //   vi.mocked(ingestDocument).mockRejectedValueOnce(new Error('insert into "chunks" … failed'));

  //   const res = await upload(validFields());

  //   expect(res.statusCode).toBe(500);
  //   expect(res.json().status).toBe('failed');
  //   expect(res.body).not.toContain('insert into');
  // });
});