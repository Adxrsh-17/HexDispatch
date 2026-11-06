import type { FastifyInstance, InjectOptions } from 'fastify';
import { INTERNAL_TOKEN_HEADER, resolveInternalToken } from './internal-auth';

/**
 * Test helper: make `app.inject()` behave like a trusted internal caller (gateway/service) by
 * adding the internal token to every request that does not set its own. Tests that exercise
 * rejection pass `x-internal-token: ''` explicitly or use the raw app.
 */
export function withInternalAuth<T extends FastifyInstance>(app: T): T {
  const original = app.inject.bind(app) as (opts: InjectOptions) => Promise<unknown>;
  (app as unknown as { inject: (opts: InjectOptions) => Promise<unknown> }).inject = (opts) =>
    original({
      ...opts,
      headers: { [INTERNAL_TOKEN_HEADER]: resolveInternalToken(), ...(opts.headers ?? {}) },
    });
  return app;
}
