import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import WebSocket from 'ws';
import { INTERNAL_TOKEN_HEADER, resolveInternalToken, signAccessToken } from '@hexdispatch/shared';
import { buildGatewayApp } from '../src/app';

describe('Gateway hardening (review problem 2)', () => {
  let core: FastifyInstance;
  let gateway: FastifyInstance;
  let corePort: number;
  let gatewayPort: number;
  let seen: Array<{ url: string; token: unknown; userId: unknown; role: unknown }> = [];

  beforeAll(async () => {
    core = Fastify();
    core.get('/health', async () => ({ status: 'ok' }));
    core.get('/rides', async (req) => {
      seen.push({
        url: req.url,
        token: req.headers[INTERNAL_TOKEN_HEADER],
        userId: req.headers['x-user-id'],
        role: req.headers['x-user-role'],
      });
      return [];
    });
    core.post('/rides/:id/transition', async () => ({ reached: 'core transition' }));
    corePort = Number(new URL(await core.listen({ host: '127.0.0.1', port: 0 })).port);

    gateway = await buildGatewayApp({
      coreApiUrl: `http://127.0.0.1:${corePort}`,
      logLevel: 'silent',
      // allowDemoWsToken intentionally left at its default (off)
    });
    gatewayPort = Number(new URL(await gateway.listen({ host: '127.0.0.1', port: 0 })).port);
  });

  afterAll(async () => {
    await gateway.close();
    await core.close();
  });

  it('has no public /rides/:id/transition route', async () => {
    const token = await signAccessToken({ userId: 'u1', role: 'RIDER', email: 'u1@example.com' });
    const res = await gateway.inject({
      method: 'POST',
      url: '/rides/3f2504e0-4f89-41d3-9a0c-0305e82c3301/transition',
      headers: { authorization: `Bearer ${token}` },
      payload: { to: 'COMPLETED', actor: 'ADMIN' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('requires the internal token on /events/broadcast', async () => {
    const payload = { room: 'ride:abc', type: 'RIDE_MATCHED', data: { driverId: 'attacker' } };

    const anonymous = await gateway.inject({ method: 'POST', url: '/events/broadcast', payload });
    expect(anonymous.statusCode).toBe(401);

    const withToken = await gateway.inject({
      method: 'POST',
      url: '/events/broadcast',
      headers: { [INTERNAL_TOKEN_HEADER]: resolveInternalToken() },
      payload,
    });
    expect(withToken.statusCode).toBe(200);
  });

  it('forwards identity from the verified JWT, never from caller-supplied headers', async () => {
    seen = [];
    const token = await signAccessToken({
      userId: 'real-user',
      role: 'RIDER',
      email: 'real@example.com',
    });
    const res = await gateway.inject({
      method: 'GET',
      url: '/rides',
      headers: {
        authorization: `Bearer ${token}`,
        'x-user-id': 'someone-else',
        'x-user-role': 'ADMIN',
        [INTERNAL_TOKEN_HEADER]: 'caller-supplied',
      },
    });
    expect(res.statusCode).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      userId: 'real-user',
      role: 'RIDER',
      token: resolveInternalToken(), // gateway's own token, not the caller's
    });
  });

  it('rejects the literal "demo" and "test" WebSocket tokens by default', async () => {
    for (const literal of ['demo', 'test']) {
      const closeCode = await new Promise<number>((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${gatewayPort}/ws?token=${literal}`);
        ws.on('close', (code) => resolve(code));
        ws.on('error', reject);
      });
      expect(closeCode).toBe(4001);
    }
  });
});
