import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import {
  INTERNAL_TOKEN_HEADER,
  assertJwtSecretConfigured,
  isValidInternalToken,
  registerInternalAuth,
  resolveInternalToken,
} from '../src';

describe('internal service auth', () => {
  it('uses a dev token outside production and an env token when set', () => {
    expect(resolveInternalToken({}).length).toBeGreaterThan(16);
    expect(resolveInternalToken({ INTERNAL_SERVICE_TOKEN: 'from-env' })).toBe('from-env');
  });

  it('refuses to boot in production without a strong INTERNAL_SERVICE_TOKEN', () => {
    expect(() => resolveInternalToken({ NODE_ENV: 'production' })).toThrow(
      /INTERNAL_SERVICE_TOKEN/,
    );
    expect(() =>
      resolveInternalToken({ NODE_ENV: 'production', INTERNAL_SERVICE_TOKEN: 'short' }),
    ).toThrow(/INTERNAL_SERVICE_TOKEN/);
    expect(
      resolveInternalToken({ NODE_ENV: 'production', INTERNAL_SERVICE_TOKEN: 'x'.repeat(32) }),
    ).toHaveLength(32);
  });

  it('compares tokens safely', () => {
    expect(isValidInternalToken('abc', 'abc')).toBe(true);
    expect(isValidInternalToken('abd', 'abc')).toBe(false);
    expect(isValidInternalToken('abcd', 'abc')).toBe(false);
    expect(isValidInternalToken(undefined, 'abc')).toBe(false);
    expect(isValidInternalToken(['abc'], 'abc')).toBe(false);
  });

  it('hook blocks everything except health/ready/metrics', async () => {
    const app = Fastify();
    registerInternalAuth(app, { token: 'secret-token-value' });
    app.get('/health', async () => 'ok');
    app.get('/private', async () => 'secret');
    await app.ready();

    expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/private' })).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/private',
          headers: { [INTERNAL_TOKEN_HEADER]: 'secret-token-value' },
        })
      ).statusCode,
    ).toBe(200);
    await app.close();
  });

  it('refuses the public dev JWT secret in production', () => {
    const prev = { env: process.env.NODE_ENV, secret: process.env.JWT_SECRET };
    try {
      process.env.NODE_ENV = 'production';
      delete process.env.JWT_SECRET;
      expect(() => assertJwtSecretConfigured()).toThrow(/JWT_SECRET/);
      process.env.JWT_SECRET = 'short';
      expect(() => assertJwtSecretConfigured()).toThrow(/32/);
      process.env.JWT_SECRET = 'a'.repeat(40);
      expect(() => assertJwtSecretConfigured()).not.toThrow();
    } finally {
      if (prev.env === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prev.env;
      if (prev.secret === undefined) delete process.env.JWT_SECRET;
      else process.env.JWT_SECRET = prev.secret;
    }
  });
});
