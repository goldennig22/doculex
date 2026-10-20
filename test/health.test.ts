import { describe, it, expect } from 'vitest';
import { buildApp } from '../src/app';

const up = async () => ({ status: 'up' as const, latencyMs: 1 });
const down = async () => ({ status: 'down' as const, latencyMs: 1, error: 'boom' });

describe('GET /health', () => {
  it('returns 200 and ok when everything is up', async () => {
    const app = buildApp({ checks: { database: up, llm: up } });
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('ok');
  });

  it('returns 503 when the database is down', async () => {
    const app = buildApp({ checks: { database: down, llm: up } });
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(503);
    expect(res.json().status).toBe('down');
  });

  it('returns 200 when the llm is down', async () => {
    const app = buildApp({ checks: { database: up, llm: down } });
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('degraded');
  });
});