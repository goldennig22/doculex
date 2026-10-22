import { describe, it, expect, beforeAll } from 'vitest';
import { buildApp } from '../../../src/app';
import { FastifyInstance } from 'fastify';

let app: FastifyInstance;

beforeAll(async () => {
  app = buildApp();
})

describe('POST /api/documents/upload', () => {
  it('Uploads and stores document chunks into the chunks table', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/documents/upload' });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("success")
    expect(res.json().data).toEqual({
      id: expect.any(String),
      documentId: expect.any(String),
      articleRef: expect.any(String),
      pageStart: expect.any(Number),
      pageEnd: expect.any(Number),
      content: expect.any(String),
      lang: expect.toBeOneOf(["en","fr"]),
      tokenCount: expect.any(Number),
    })
  });
  it('Error Occurs during upload', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/documents/upload' });
    expect(res.statusCode).toBe(422);
    expect(res.json().status).toBe("failed")
  });
  
})