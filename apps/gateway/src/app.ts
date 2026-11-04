import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type Redis from 'ioredis';
import {
  buildServer,
  AppError,
  verifyToken,
  RateLimiter,
  type AuthTokenPayload,
} from '@hexdispatch/shared';

export interface GatewayOptions {
  coreApiUrl?: string;
  redisClient?: Redis;
  logLevel?: string;
  rateLimitMax?: number;
  rateLimitWindowSec?: number;
}

export function buildGatewayApp(options: GatewayOptions = {}): FastifyInstance {
  const {
    coreApiUrl = process.env.CORE_API_URL ?? 'http://localhost:3001',
    redisClient,
    logLevel,
    rateLimitMax = Number(process.env.RATE_LIMIT_MAX ?? 100),
    rateLimitWindowSec = Number(process.env.RATE_LIMIT_WINDOW_SEC ?? 60),
  } = options;

  const rateLimiter = new RateLimiter(redisClient);

  const app = buildServer({
    service: 'gateway',
    logLevel,
    readinessChecks: {
      coreApi: async () => {
        const res = await fetch(`${coreApiUrl}/health`, { signal: AbortSignal.timeout(2000) });
        if (!res.ok) throw new Error(`Core API health check failed with status ${res.status}`);
      },
    },
  });

  // Extract auth from Authorization header
  async function authenticate(request: FastifyRequest): Promise<AuthTokenPayload> {
    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw AppError.unauthorized('Missing or invalid Authorization header');
    }
    const token = authHeader.slice(7).trim();
    return verifyToken(token);
  }

  // Rate limit hook helper
  async function applyRateLimit(identifier: string, reply: FastifyReply) {
    const result = await rateLimiter.check(identifier, {
      maxRequests: rateLimitMax,
      windowSec: rateLimitWindowSec,
    });

    reply.header('x-ratelimit-limit', String(result.limit));
    reply.header('x-ratelimit-remaining', String(result.remaining));
    reply.header('x-ratelimit-reset', String(result.resetAfterSec));

    if (!result.allowed) {
      reply.header('retry-after', String(result.resetAfterSec));
      throw new AppError('RATE_LIMIT_EXCEEDED', 'Too many requests, please try again later', 429, {
        retryAfter: result.resetAfterSec,
      });
    }
  }

  // Forwarding helper to core-api
  async function forwardToCoreApi(
    request: FastifyRequest,
    reply: FastifyReply,
    user?: AuthTokenPayload,
  ) {
    const targetUrl = new URL(request.url, coreApiUrl).toString();
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-request-id': request.id,
    };

    const idempotencyKey = request.headers['idempotency-key'];
    if (typeof idempotencyKey === 'string') {
      headers['idempotency-key'] = idempotencyKey;
    }

    if (user) {
      headers['x-user-id'] = user.userId;
      headers['x-user-role'] = user.role;
      headers['x-user-email'] = user.email;
    }

    const fetchOptions: RequestInit = {
      method: request.method,
      headers,
    };

    if (request.method !== 'GET' && request.method !== 'HEAD' && request.body) {
      fetchOptions.body = JSON.stringify(request.body);
    }

    const response = await fetch(targetUrl, fetchOptions);
    const contentType = response.headers.get('content-type') ?? '';

    reply.code(response.status);
    if (contentType.includes('application/json')) {
      const data = await response.json();
      return reply.send(data);
    }
    const text = await response.text();
    return reply.send(text);
  }

  // --- Public Auth Routes (IP-based rate limiting) ---
  app.post('/auth/signup', async (request, reply) => {
    await applyRateLimit(`ip:${request.ip}`, reply);
    return forwardToCoreApi(request, reply);
  });

  app.post('/auth/login', async (request, reply) => {
    await applyRateLimit(`ip:${request.ip}`, reply);
    return forwardToCoreApi(request, reply);
  });

  app.post('/auth/refresh', async (request, reply) => {
    await applyRateLimit(`ip:${request.ip}`, reply);
    return forwardToCoreApi(request, reply);
  });

  // --- Driver Routes ---
  app.patch('/drivers/me/status', async (request, reply) => {
    const user = await authenticate(request);
    if (user.role !== 'DRIVER') {
      throw AppError.forbidden('Forbidden: DRIVER role required');
    }
    await applyRateLimit(`user:${user.userId}`, reply);
    return forwardToCoreApi(request, reply, user);
  });

  app.get('/drivers/me', async (request, reply) => {
    const user = await authenticate(request);
    if (user.role !== 'DRIVER') {
      throw AppError.forbidden('Forbidden: DRIVER role required');
    }
    await applyRateLimit(`user:${user.userId}`, reply);
    return forwardToCoreApi(request, reply, user);
  });

  // --- Ride Routes ---
  app.post('/rides', async (request, reply) => {
    const user = await authenticate(request);
    if (user.role !== 'RIDER' && user.role !== 'ADMIN') {
      throw AppError.forbidden('Forbidden: RIDER role required');
    }
    await applyRateLimit(`user:${user.userId}`, reply);
    return forwardToCoreApi(request, reply, user);
  });

  app.get('/rides/:id', async (request, reply) => {
    const user = await authenticate(request);
    await applyRateLimit(`user:${user.userId}`, reply);
    return forwardToCoreApi(request, reply, user);
  });

  app.get('/rides', async (request, reply) => {
    const user = await authenticate(request);
    await applyRateLimit(`user:${user.userId}`, reply);
    return forwardToCoreApi(request, reply, user);
  });

  app.post('/rides/:id/cancel', async (request, reply) => {
    const user = await authenticate(request);
    if (user.role !== 'RIDER' && user.role !== 'ADMIN') {
      throw AppError.forbidden('Forbidden: RIDER role required');
    }
    await applyRateLimit(`user:${user.userId}`, reply);
    return forwardToCoreApi(request, reply, user);
  });

  app.post('/rides/:id/transition', async (request, reply) => {
    const user = await authenticate(request);
    await applyRateLimit(`user:${user.userId}`, reply);
    return forwardToCoreApi(request, reply, user);
  });

  return app;
}
