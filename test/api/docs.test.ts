import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app';

let app: FastifyInstance;
beforeAll(async () => {
  app = buildApp();
  await app.ready();
});
afterAll(async () => {
  await app.close();
});

describe('OpenAPI document (/docs/json)', () => {
  const spec = async () => (await app.inject({ method: 'GET', url: '/docs/json' })).json();

  it('documents both /ask outcomes, answered and found: false', async () => {
    const examples = (await spec()).paths['/api/ai/ask'].post.responses['200'].content['application/json'].examples;

    expect(Object.keys(examples)).toEqual(['answered', 'notFound']);
    expect(examples.notFound.value.data).toEqual({ found: false, answer: null, citations: [], confidence: null, language: 'fr' });
  });

  it('documents the upload as multipart with a binary file, behind the API key', async () => {
    const upload = (await spec()).paths['/api/documents/upload'].post;

    expect(upload.requestBody.content['multipart/form-data'].schema.properties.file).toEqual({ type: 'string', format: 'binary' });
    expect(upload.security).toEqual([{ adminKey: [] }]);
  });

  it('documents the decision upload as multipart, behind a role-based key, with no 403 (contributor is the lowest role)', async () => {
    const create = (await spec()).paths['/api/decisions'].post;

    expect(create.requestBody.content['multipart/form-data'].schema.properties.file).toMatchObject({ type: 'string', format: 'binary' });
    expect(create.security).toEqual([{ apiKey: [] }]);
    expect(Object.keys(create.responses)).toEqual(['201', '401', '413', '422', '429']);
  });

  it('keeps the unfinished update route and the demo page out of the docs', async () => {
    const paths = Object.keys((await spec()).paths);

    expect(paths).not.toContain('/api/documents/{documentId}/update');
    expect(paths).not.toContain('/');
  });
});

describe('demo page (/)', () => {
  it('serves the HTML page', async () => {
    const res = await app.inject({ method: 'GET', url: '/' });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('<form id="ask">');
  });
});
