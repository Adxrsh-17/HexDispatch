import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { AppError } from './errors';

/**
 * Service-to-service authentication.
 *
 * The gateway is the only public entry point. Every other service (and the gateway's own
 * /events/broadcast) requires this shared secret, so a caller who reaches a service port directly
 * cannot forge `x-user-id` / `x-user-role` or call internal routes.
 */
export const INTERNAL_TOKEN_HEADER = 'x-internal-token';

const DEV_INTERNAL_TOKEN = 'hexdispatch-dev-internal-token-not-for-production';

/** Production requires INTERNAL_SERVICE_TOKEN (>= 16 chars). Elsewhere a dev default is used. */
export function resolveInternalToken(
  env: Record<string, string | undefined> = process.env,
): string {
  const configured = env.INTERNAL_SERVICE_TOKEN;
  if (env.NODE_ENV === 'production') {
    if (!configured || configured.length < 16) {
      throw new Error('INTERNAL_SERVICE_TOKEN (>= 16 chars) is required when NODE_ENV=production');
    }
    return configured;
  }
  return configured && configured.length > 0 ? configured : DEV_INTERNAL_TOKEN;
}

export function isValidInternalToken(provided: unknown, expected: string): boolean {
  if (typeof provided !== 'string') return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Headers to attach to every service-to-service call. */
export function internalHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { [INTERNAL_TOKEN_HEADER]: resolveInternalToken(), ...extra };
}

/** `fetch` that always carries the internal token. Use for every call between our own services. */
export function internalFetch(input: string | URL, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set(INTERNAL_TOKEN_HEADER, resolveInternalToken());
  return fetch(input, { ...init, headers });
}

/** Throws 401 unless the request carries a valid internal token. For single routes. */
export function assertInternalRequest(
  request: FastifyRequest,
  token: string = resolveInternalToken(),
): void {
  if (!isValidInternalToken(request.headers[INTERNAL_TOKEN_HEADER], token)) {
    throw AppError.unauthorized('Internal service credentials required');
  }
}

const DEFAULT_PUBLIC_PATHS = ['/health', '/ready', '/metrics'];

export interface InternalAuthOptions {
  token?: string;
  /** Paths that stay open (liveness, readiness, metrics by default). */
  publicPaths?: string[];
  /** Path prefixes that stay open (for example API docs). */
  publicPrefixes?: string[];
}

/** Reject every request that does not carry the internal token, except health/ready/metrics. */
export function registerInternalAuth(
  app: FastifyInstance,
  options: InternalAuthOptions = {},
): void {
  const token = options.token ?? resolveInternalToken();
  const publicPaths = new Set(options.publicPaths ?? DEFAULT_PUBLIC_PATHS);
  const prefixes = options.publicPrefixes ?? [];

  app.addHook('onRequest', async (request) => {
    const path = request.url.split('?')[0] ?? '';
    if (publicPaths.has(path) || prefixes.some((p) => path.startsWith(p))) return;
    if (!isValidInternalToken(request.headers[INTERNAL_TOKEN_HEADER], token)) {
      throw AppError.unauthorized('Internal service credentials required');
    }
  });
}
