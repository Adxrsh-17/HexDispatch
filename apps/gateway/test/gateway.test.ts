import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildGatewayApp } from '../src/app';
import { signAccessToken, type UserRole } from '@hexdispatch/shared';
import Fastify, { type FastifyInstance } from 'fastify';

describe('Gateway Security & Rate Limiting (AC4)', () => {
  let mockCoreApi: FastifyInstance;
  let gatewayApp: FastifyInstance;
  const CORE_PORT = 3199;

  beforeAll(async () => {
    // Spin up lightweight mock Core API
    mockCoreApi = Fastify();
    mockCoreApi.get('/health', async () => ({ status: 'ok' }));
    mockCoreApi.post('/rides', async (req) => ({
      id: 'mock-ride-123',
      status: 'REQUESTED',
      riderId: req.headers['x-user-id'],
    }));
    mockCoreApi.get('/rides', async () => []);
    mockCoreApi.patch('/drivers/me/status', async (req) => ({
      online: true,
      userId: req.headers['x-user-id'],
    }));
    mockCoreApi.get('/drivers/me', async (req) => ({
      userId: req.headers['x-user-id'],
      vehicleType: 'sedan',
    }));
    await mockCoreApi.listen({ host: '127.0.0.1', port: CORE_PORT });

    // Initialize Gateway pointing to mock Core API, with rateLimitMax = 3
    gatewayApp = buildGatewayApp({
      coreApiUrl: `http://127.0.0.1:${CORE_PORT}`,
      rateLimitMax: 3,
      rateLimitWindowSec: 30,
      logLevel: 'silent',
    });
    await gatewayApp.ready();
  });

  afterAll(async () => {
    await gatewayApp.close();
    await mockCoreApi.close();
  });

  async function createToken(
    userId: string,
    role: UserRole,
    email = 'user@example.com',
  ): Promise<string> {
    return signAccessToken({ userId, role, email });
  }

  describe('Authentication Enforcement', () => {
    it('rejects unauthenticated requests to protected routes with 401', async () => {
      const res = await gatewayApp.inject({
        method: 'POST',
        url: '/rides',
        payload: {
          pickup: { lat: 12.9, lng: 77.6 },
          dropoff: { lat: 12.95, lng: 77.65 },
        },
      });

      expect(res.statusCode).toBe(401);
      const body = res.json();
      expect(body.error.code).toBe('UNAUTHORIZED');
      expect(body.error.message).toContain('Authorization');
    });

    it('rejects invalid token with 401', async () => {
      const res = await gatewayApp.inject({
        method: 'POST',
        url: '/rides',
        headers: {
          authorization: 'Bearer invalid.jwt.token',
        },
        payload: {},
      });

      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe('UNAUTHORIZED');
    });
  });

  describe('Role-Based Access Control (RBAC)', () => {
    it('rejects RIDER role attempting to access driver endpoint with 403', async () => {
      const riderToken = await createToken('rider-1', 'RIDER');

      const res = await gatewayApp.inject({
        method: 'PATCH',
        url: '/drivers/me/status',
        headers: {
          authorization: `Bearer ${riderToken}`,
        },
        payload: { online: true },
      });

      expect(res.statusCode).toBe(403);
      const body = res.json();
      expect(body.error.code).toBe('FORBIDDEN');
      expect(body.error.message).toContain('DRIVER role required');
    });

    it('rejects DRIVER role attempting to request a ride with 403', async () => {
      const driverToken = await createToken('driver-1', 'DRIVER');

      const res = await gatewayApp.inject({
        method: 'POST',
        url: '/rides',
        headers: {
          authorization: `Bearer ${driverToken}`,
        },
        payload: {
          pickup: { lat: 12.9, lng: 77.6 },
          dropoff: { lat: 12.95, lng: 77.65 },
        },
      });

      expect(res.statusCode).toBe(403);
      const body = res.json();
      expect(body.error.code).toBe('FORBIDDEN');
      expect(body.error.message).toContain('RIDER role required');
    });
  });

  describe('Rate Limiting', () => {
    it('returns 429 with Retry-After when rate limit is exceeded', async () => {
      const riderToken = await createToken('rate-limited-user', 'RIDER');
      const headers = { authorization: `Bearer ${riderToken}` };

      // Requests 1, 2, 3 must succeed
      for (let i = 1; i <= 3; i++) {
        const res = await gatewayApp.inject({
          method: 'GET',
          url: '/rides',
          headers,
        });
        expect(res.statusCode).toBe(200);
        expect(res.headers['x-ratelimit-remaining']).toBe(String(3 - i));
      }

      // Request 4 must be rate-limited
      const limitedRes = await gatewayApp.inject({
        method: 'GET',
        url: '/rides',
        headers,
      });

      expect(limitedRes.statusCode).toBe(429);
      expect(limitedRes.headers['retry-after']).toBeDefined();
      expect(Number(limitedRes.headers['retry-after'])).toBeGreaterThan(0);
      expect(limitedRes.headers['x-ratelimit-remaining']).toBe('0');

      const body = limitedRes.json();
      expect(body.error.code).toBe('RATE_LIMIT_EXCEEDED');
      expect(body.error.details.retryAfter).toBeGreaterThan(0);
    });
  });
});
