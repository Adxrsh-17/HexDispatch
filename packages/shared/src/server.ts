import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyBaseLogger, type FastifyError, type FastifyInstance } from 'fastify';
import { collectDefaultMetrics, Histogram, Registry } from 'prom-client';
import { ZodError } from 'zod';
import { AppError, type ErrorBody } from './errors';
import { createLogger } from './logger';

declare module 'fastify' {
  interface FastifyInstance {
    /** Per-server prom-client registry served at /metrics. Register service metrics here. */
    metrics: Registry;
  }
}

export type ReadinessCheck = () => Promise<void>;

export interface BuildServerOptions {
  service: string;
  logLevel?: string;
  /** Named dependency probes. /ready returns 503 if any throws. */
  readinessChecks?: Record<string, ReadinessCheck>;
}

/**
 * Standard Fastify server for every HexDispatch app.
 * Provides /health (liveness), /ready (dependencies), /metrics (Prometheus),
 * a correlation id (x-request-id), and uniform JSON errors.
 */
export function buildServer(options: BuildServerOptions): FastifyInstance {
  const { service, logLevel, readinessChecks = {} } = options;

  const logger = createLogger({ service, level: logLevel });
  const app = Fastify({
    loggerInstance: logger as FastifyBaseLogger,
    requestIdHeader: 'x-request-id',
    genReqId: () => randomUUID(),
  });

  const registry = new Registry();
  registry.setDefaultLabels({ service });
  collectDefaultMetrics({ register: registry });
  const httpDuration = new Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP request duration in seconds',
    labelNames: ['method', 'route', 'status'] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [registry],
  });
  app.decorate('metrics', registry);

  app.addHook('onSend', async (request, reply) => {
    reply.header('x-request-id', request.id);
  });
  app.addHook('onResponse', async (request, reply) => {
    httpDuration
      .labels(request.method, request.routeOptions.url ?? 'unmatched', String(reply.statusCode))
      .observe(reply.elapsedTime / 1000);
  });

  app.get('/health', async () => ({
    status: 'ok',
    service,
    uptimeSec: Math.round(process.uptime()),
  }));

  app.get('/ready', async (_request, reply) => {
    const failed: string[] = [];
    for (const [name, check] of Object.entries(readinessChecks)) {
      try {
        await check();
      } catch {
        failed.push(name);
      }
    }
    if (failed.length > 0) {
      return reply.code(503).send({ status: 'not_ready', service, failed });
    }
    return { status: 'ready', service };
  });

  app.get('/metrics', async (_request, reply) => {
    reply.type(registry.contentType);
    return registry.metrics();
  });

  app.setNotFoundHandler((request, reply) => {
    const body: ErrorBody = {
      error: { code: 'NOT_FOUND', message: 'Route not found', requestId: request.id },
    };
    return reply.code(404).send(body);
  });

  app.setErrorHandler((error: FastifyError | Error, request, reply) => {
    if (error instanceof AppError) {
      return reply.code(error.status).send(error.toBody(request.id));
    }
    if (error instanceof ZodError) {
      const body: ErrorBody = {
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Request validation failed',
          details: error.issues,
          requestId: request.id,
        },
      };
      return reply.code(400).send(body);
    }
    // Fastify's own client errors (bad JSON, 404s, payload too large) carry statusCode.
    const { statusCode: status, code } = error as Partial<FastifyError>;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      const body: ErrorBody = {
        error: { code: code ?? 'BAD_REQUEST', message: error.message, requestId: request.id },
      };
      return reply.code(status).send(body);
    }
    request.log.error({ err: error }, 'unhandled error');
    const body: ErrorBody = {
      error: { code: 'INTERNAL', message: 'Internal server error', requestId: request.id },
    };
    return reply.code(500).send(body);
  });

  return app;
}

/** Listen, and close cleanly on SIGINT/SIGTERM. */
export async function startServer(
  app: FastifyInstance,
  { host, port }: { host: string; port: number },
): Promise<void> {
  const shutdown = (signal: string) => {
    app.log.info({ signal }, 'shutting down');
    app
      .close()
      .then(() => process.exit(0))
      .catch((err: unknown) => {
        app.log.error({ err }, 'error during shutdown');
        process.exit(1);
      });
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  await app.listen({ host, port });
}
