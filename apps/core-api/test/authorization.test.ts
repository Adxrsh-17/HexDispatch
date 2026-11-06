import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { INTERNAL_TOKEN_HEADER, resolveInternalToken } from '@hexdispatch/shared';
import { createTestDb } from './test-db';
import { buildCoreApiApp } from '../src/app';
import { users } from '../src/db/schema';

type TestDbResult = Awaited<ReturnType<typeof createTestDb>>;

const internal = { [INTERNAL_TOKEN_HEADER]: resolveInternalToken() };
const asUser = (userId: string, role: 'RIDER' | 'DRIVER' | 'ADMIN') => ({
  ...internal,
  'x-user-id': userId,
  'x-user-role': role,
});

describe('core-api authorization (review problem 2)', () => {
  let testDb: TestDbResult;
  let app: FastifyInstance;
  const riderA = randomUUID();
  const riderB = randomUUID();
  let rideOfA: string;

  const ridePayload = {
    pickup: { lat: 12.9716, lng: 77.5946 },
    dropoff: { lat: 12.9352, lng: 77.6245 },
  };

  beforeAll(async () => {
    testDb = await createTestDb();
    for (const [id, email] of [
      [riderA, 'a@example.com'],
      [riderB, 'b@example.com'],
    ] as const) {
      await testDb.db.insert(users).values({ id, email, passwordHash: 'x', role: 'RIDER' });
    }
    app = await buildCoreApiApp({ db: testDb.db, logLevel: 'silent' });
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/rides',
      headers: asUser(riderA, 'RIDER'),
      payload: ridePayload,
    });
    expect(res.statusCode).toBe(201);
    rideOfA = res.json().id;
  });

  afterAll(async () => {
    await app.close();
    await testDb.client.close();
  });

  it('rejects requests without the internal token (direct hits on the service port)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/rides',
      headers: { 'x-user-id': riderA, 'x-user-role': 'RIDER' }, // forged identity, no token
      payload: ridePayload,
    });
    expect(res.statusCode).toBe(401);

    const wrong = await app.inject({
      method: 'GET',
      url: `/rides/${rideOfA}`,
      headers: { [INTERNAL_TOKEN_HEADER]: 'not-the-token' },
    });
    expect(wrong.statusCode).toBe(401);
  });

  it('keeps health and metrics open for probes', async () => {
    expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/metrics' })).statusCode).toBe(200);
  });

  it("does not let rider B read rider A's ride (no IDOR)", async () => {
    const owner = await app.inject({
      method: 'GET',
      url: `/rides/${rideOfA}`,
      headers: asUser(riderA, 'RIDER'),
    });
    expect(owner.statusCode).toBe(200);

    const other = await app.inject({
      method: 'GET',
      url: `/rides/${rideOfA}`,
      headers: asUser(riderB, 'RIDER'),
    });
    expect(other.statusCode).toBe(404);
  });

  it("scopes ride listing to the caller's own rides", async () => {
    const mine = await app.inject({
      method: 'GET',
      url: '/rides',
      headers: asUser(riderA, 'RIDER'),
    });
    expect(mine.json().map((r: { id: string }) => r.id)).toContain(rideOfA);

    const theirs = await app.inject({
      method: 'GET',
      url: '/rides',
      headers: asUser(riderB, 'RIDER'),
    });
    expect(theirs.json()).toEqual([]);

    const service = await app.inject({ method: 'GET', url: '/rides', headers: internal });
    expect(service.json().map((r: { id: string }) => r.id)).toContain(rideOfA);
  });

  it("does not let rider B cancel rider A's ride", async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/rides/${rideOfA}/cancel`,
      headers: asUser(riderB, 'RIDER'),
    });
    expect(res.statusCode).toBe(404);
  });

  it('ignores a spoofed body.actor from an end user (cannot claim ADMIN or DRIVER)', async () => {
    const asAdmin = await app.inject({
      method: 'POST',
      url: `/rides/${rideOfA}/transition`,
      headers: asUser(riderB, 'RIDER'),
      payload: { to: 'FAILED', actor: 'ADMIN' },
    });
    expect(asAdmin.statusCode).toBe(400);
    expect(asAdmin.json().error.message).toContain('by actor RIDER');

    const asDriver = await app.inject({
      method: 'POST',
      url: `/rides/${rideOfA}/transition`,
      headers: asUser(riderB, 'RIDER'),
      payload: { to: 'MATCHING', actor: 'SYSTEM' },
    });
    expect(asDriver.statusCode).toBe(400);
  });

  it('lets an internal service name the actor (dispatch drives the trip)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/rides/${rideOfA}/transition`,
      headers: internal,
      payload: { to: 'MATCHING', actor: 'SYSTEM' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('MATCHING');
  });

  it('does not allow self-service ADMIN signup', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/signup',
      headers: internal,
      payload: {
        email: `admin.${randomUUID()}@example.com`,
        password: 'password123',
        role: 'ADMIN',
      },
    });
    expect(res.statusCode).toBe(400);
  });
});
