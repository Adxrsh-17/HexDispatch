import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { AppError, buildServer, loadEnv, loadServiceEnv, baseEnvSchema } from '../src';

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('buildServer', () => {
  it('serves /health with 200', async () => {
    app = buildServer({ service: 'test-svc', logLevel: 'silent' });
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok', service: 'test-svc' });
    expect(res.headers['x-request-id']).toBeTruthy();
  });

  it('/ready reflects readiness checks', async () => {
    app = buildServer({
      service: 'test-svc',
      logLevel: 'silent',
      readinessChecks: {
        ok: async () => {},
        broken: async () => {
          throw new Error('down');
        },
      },
    });
    const res = await app.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ status: 'not_ready', failed: ['broken'] });
  });

  it('/metrics exposes prometheus text including http duration', async () => {
    app = buildServer({ service: 'test-svc', logLevel: 'silent' });
    await app.inject({ method: 'GET', url: '/health' });
    const res = await app.inject({ method: 'GET', url: '/metrics' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('http_request_duration_seconds');
    expect(res.body).toContain('process_cpu_user_seconds_total');
  });

  it('maps AppError to its status and JSON body', async () => {
    app = buildServer({ service: 'test-svc', logLevel: 'silent' });
    app.get('/boom', async () => {
      throw AppError.conflict('already exists');
    });
    const res = await app.inject({ method: 'GET', url: '/boom' });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: { code: 'CONFLICT', message: 'already exists' } });
  });

  it('hides unexpected errors behind a 500', async () => {
    app = buildServer({ service: 'test-svc', logLevel: 'silent' });
    app.get('/crash', async () => {
      throw new Error('secret internals');
    });
    const res = await app.inject({ method: 'GET', url: '/crash' });
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain('secret internals');
  });
});

describe('config', () => {
  it('applies defaults', () => {
    expect(loadEnv(baseEnvSchema, {})).toEqual({
      NODE_ENV: 'development',
      LOG_LEVEL: 'info',
      HOST: '0.0.0.0',
    });
  });

  it('reads the per-service port variable', () => {
    expect(loadServiceEnv('GATEWAY_PORT', 3000, {}).PORT).toBe(3000);
    expect(loadServiceEnv('GATEWAY_PORT', 3000, { GATEWAY_PORT: '4100' }).PORT).toBe(4100);
  });

  it('rejects invalid values with a readable error', () => {
    expect(() => loadServiceEnv('GATEWAY_PORT', 3000, { GATEWAY_PORT: 'abc' })).toThrow(
      /Invalid environment/,
    );
    expect(() => loadEnv(baseEnvSchema, { LOG_LEVEL: 'loud' })).toThrow(/LOG_LEVEL/);
  });
});
