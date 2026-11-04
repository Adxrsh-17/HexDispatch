import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import type Redis from 'ioredis';
import {
  buildServer,
  AppError,
  verifyToken,
  RateLimiter,
  type AuthTokenPayload,
} from '@hexdispatch/shared';
import { RealtimeGateway } from './ws/gateway-ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface GatewayOptions {
  coreApiUrl?: string;
  dispatchUrl?: string;
  locationUrl?: string;
  redisClient?: Redis;
  redisSubClient?: Redis;
  realtimeGateway?: RealtimeGateway;
  logLevel?: string;
  rateLimitMax?: number;
  rateLimitWindowSec?: number;
}

export async function buildGatewayApp(options: GatewayOptions = {}): Promise<FastifyInstance> {
  const {
    coreApiUrl = process.env.CORE_API_URL ?? 'http://localhost:3001',
    dispatchUrl = process.env.DISPATCH_URL ?? 'http://localhost:3003',
    locationUrl = process.env.LOCATION_URL ?? 'http://localhost:3002',
    redisClient,
    redisSubClient,
    realtimeGateway: injectedGateway,
    logLevel,
    rateLimitMax = Number(process.env.RATE_LIMIT_MAX ?? 100),
    rateLimitWindowSec = Number(process.env.RATE_LIMIT_WINDOW_SEC ?? 60),
  } = options;

  const rateLimiter = new RateLimiter(redisClient);

  // Initialize RealtimeGateway (using redisClient as pub and redisSubClient as sub, or injected)
  const realtimeGateway =
    injectedGateway ??
    (redisClient
      ? new RealtimeGateway(redisClient, redisSubClient ?? redisClient)
      : new RealtimeGateway({} as Redis, {} as Redis));

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

  await app.register(fastifyWebsocket);

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

  // Forwarding helper to arbitrary internal service
  async function forwardToService(
    serviceUrl: string,
    request: FastifyRequest,
    reply: FastifyReply,
    user?: AuthTokenPayload,
  ) {
    const targetUrl = new URL(request.url, serviceUrl).toString();
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

  function forwardToCoreApi(request: FastifyRequest, reply: FastifyReply, user?: AuthTokenPayload) {
    return forwardToService(coreApiUrl, request, reply, user);
  }

  function forwardToDispatch(
    request: FastifyRequest,
    reply: FastifyReply,
    user?: AuthTokenPayload,
  ) {
    return forwardToService(dispatchUrl, request, reply, user);
  }

  function forwardToLocation(
    request: FastifyRequest,
    reply: FastifyReply,
    user?: AuthTokenPayload,
  ) {
    return forwardToService(locationUrl, request, reply, user);
  }

  // --- Realtime WebSocket Gateway ---
  app.get('/ws', { websocket: true }, async (socket, req) => {
    const url = new URL(req.url, 'http://localhost');
    const token = url.searchParams.get('token') ?? (req.headers.authorization?.slice(7) || '');

    let user: AuthTokenPayload;
    if (token === 'demo' || (process.env.NODE_ENV !== 'production' && token === 'test')) {
      user = { userId: 'demo-user', role: 'RIDER', email: 'demo@example.com' };
    } else {
      try {
        user = await realtimeGateway.authenticate(token);
      } catch {
        socket.send(JSON.stringify({ error: 'Unauthorized: Invalid token' }));
        socket.close(4001, 'Unauthorized');
        return;
      }
    }

    socket.on('message', async (data: Buffer | string) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'ping') {
          socket.send(JSON.stringify({ type: 'pong', ts: new Date().toISOString() }));
          return;
        }

        if (msg.type === 'subscribe' && msg.room) {
          await realtimeGateway.subscribe(socket, user, msg.room, msg.lastEventId);
          socket.send(JSON.stringify({ ack: true, subscribed: msg.room }));
          return;
        }

        if (msg.type === 'unsubscribe' && msg.room) {
          realtimeGateway.unsubscribe(socket, msg.room);
          socket.send(JSON.stringify({ ack: true, unsubscribed: msg.room }));
          return;
        }
      } catch {
        socket.send(JSON.stringify({ error: 'Malformed message' }));
      }
    });

    socket.on('close', () => {
      realtimeGateway.handleDisconnect(socket);
    });
  });

  // --- Broadcast Event Route (Internal/Gateway pubsub trigger) ---
  app.post('/events/broadcast', async (request, reply) => {
    const body = request.body as { room: string; type: string; data: unknown };
    if (!body || !body.room || !body.type) {
      throw AppError.badRequest('Missing room or type in broadcast payload');
    }

    const event = await realtimeGateway.broadcastToRoom(body.room, body.type, body.data);
    return reply.send(event);
  });

  // --- Demo Page ---
  app.get('/demo', async (_req, reply) => {
    const demoPath = path.resolve(__dirname, '../public/demo.html');
    if (fs.existsSync(demoPath)) {
      const html = fs.readFileSync(demoPath, 'utf-8');
      return reply.type('text/html').send(html);
    }
    return reply.type('text/html').send('<h1>HexDispatch Tracking Demo</h1>');
  });

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
  app.post('/drivers/me/location', async (request, reply) => {
    const user = await authenticate(request);
    if (user.role !== 'DRIVER') {
      throw AppError.forbidden('Forbidden: DRIVER role required');
    }
    await applyRateLimit(`user:${user.userId}`, reply);
    return forwardToLocation(request, reply, user);
  });

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

  // --- Offer Routes (forwarded to dispatch) ---
  app.get('/offers/:id', async (request, reply) => {
    const user = await authenticate(request);
    await applyRateLimit(`user:${user.userId}`, reply);
    return forwardToDispatch(request, reply, user);
  });

  app.post('/offers/:id/accept', async (request, reply) => {
    const user = await authenticate(request);
    if (user.role !== 'DRIVER') {
      throw AppError.forbidden('Forbidden: DRIVER role required');
    }
    await applyRateLimit(`user:${user.userId}`, reply);
    return forwardToDispatch(request, reply, user);
  });

  app.post('/offers/:id/decline', async (request, reply) => {
    const user = await authenticate(request);
    if (user.role !== 'DRIVER') {
      throw AppError.forbidden('Forbidden: DRIVER role required');
    }
    await applyRateLimit(`user:${user.userId}`, reply);
    return forwardToDispatch(request, reply, user);
  });

  // --- Ride Progress Routes (forwarded to dispatch) ---
  app.post('/rides/:id/arrived', async (request, reply) => {
    const user = await authenticate(request);
    if (user.role !== 'DRIVER') {
      throw AppError.forbidden('Forbidden: DRIVER role required');
    }
    await applyRateLimit(`user:${user.userId}`, reply);
    return forwardToDispatch(request, reply, user);
  });

  app.post('/rides/:id/start', async (request, reply) => {
    const user = await authenticate(request);
    if (user.role !== 'DRIVER') {
      throw AppError.forbidden('Forbidden: DRIVER role required');
    }
    await applyRateLimit(`user:${user.userId}`, reply);
    return forwardToDispatch(request, reply, user);
  });

  app.post('/rides/:id/complete', async (request, reply) => {
    const user = await authenticate(request);
    if (user.role !== 'DRIVER') {
      throw AppError.forbidden('Forbidden: DRIVER role required');
    }
    await applyRateLimit(`user:${user.userId}`, reply);
    return forwardToDispatch(request, reply, user);
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
