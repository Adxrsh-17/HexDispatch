import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDb } from './test-db';
import { buildCoreApiApp } from '../src/app';
import { users, rides, idempotencyKeys } from '../src/db/schema';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';

type TestDbResult = Awaited<ReturnType<typeof createTestDb>>;

describe('Idempotency & Ride Creation (AC1)', () => {
  let db: TestDbResult['db'];
  let client: TestDbResult['client'];
  let app: FastifyInstance;
  let riderId: string;

  beforeAll(async () => {
    const testDb = await createTestDb();
    db = testDb.db;
    client = testDb.client;

    const [user] = await db
      .insert(users)
      .values({
        email: 'ac1-rider@example.com',
        passwordHash: 'hash',
        role: 'RIDER',
      })
      .returning();
    riderId = user!.id;

    app = await buildCoreApiApp({ db, logLevel: 'silent' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    if (client) {
      await client.close();
    }
  });

  it('repeating the same POST /rides with the same Idempotency-Key returns the same ride and creates exactly one row', async () => {
    const idempotencyKey = 'ride-req-key-12345';
    const payload = {
      pickup: { lat: 12.9716, lng: 77.5946 },
      dropoff: { lat: 12.9352, lng: 77.6245 },
      vehicleType: 'sedan',
    };

    // First request
    const res1 = await app.inject({
      method: 'POST',
      url: '/rides',
      headers: {
        'idempotency-key': idempotencyKey,
        'x-user-id': riderId,
        'x-user-role': 'RIDER',
      },
      payload,
    });

    expect(res1.statusCode).toBe(201);
    const ride1 = res1.json();
    expect(ride1.id).toBeDefined();
    expect(ride1.status).toBe('REQUESTED');
    expect(ride1.idempotencyKey).toBe(idempotencyKey);

    // Second request with exact same Idempotency-Key and payload
    const res2 = await app.inject({
      method: 'POST',
      url: '/rides',
      headers: {
        'idempotency-key': idempotencyKey,
        'x-user-id': riderId,
        'x-user-role': 'RIDER',
      },
      payload,
    });

    expect(res2.statusCode).toBe(201);
    const ride2 = res2.json();
    // Returns exact same ride
    expect(ride2.id).toBe(ride1.id);
    expect(ride2.fareEstimate).toBe(ride1.fareEstimate);
    expect(ride2.createdAt).toBe(ride1.createdAt);

    // Verify exactly ONE row was created in the database
    const matchingRides = await db
      .select()
      .from(rides)
      .where(eq(rides.idempotencyKey, idempotencyKey));
    expect(matchingRides.length).toBe(1);
    expect(matchingRides[0]!.id).toBe(ride1.id);

    // Verify exactly one idempotency_keys record exists
    const keys = await db
      .select()
      .from(idempotencyKeys)
      .where(eq(idempotencyKeys.key, idempotencyKey));
    expect(keys.length).toBe(1);
  });

  it('returns 422 when same Idempotency-Key is reused with different request payload', async () => {
    const idempotencyKey = 'conflict-key-999';
    const initialPayload = {
      pickup: { lat: 12.9716, lng: 77.5946 },
      dropoff: { lat: 12.9352, lng: 77.6245 },
      vehicleType: 'sedan',
    };

    // First request succeeds
    const res1 = await app.inject({
      method: 'POST',
      url: '/rides',
      headers: {
        'idempotency-key': idempotencyKey,
        'x-user-id': riderId,
      },
      payload: initialPayload,
    });
    expect(res1.statusCode).toBe(201);

    // Second request with DIFFERENT payload
    const modifiedPayload = {
      pickup: { lat: 13.0827, lng: 80.2707 },
      dropoff: { lat: 12.9352, lng: 77.6245 },
      vehicleType: 'suv',
    };

    const res2 = await app.inject({
      method: 'POST',
      url: '/rides',
      headers: {
        'idempotency-key': idempotencyKey,
        'x-user-id': riderId,
      },
      payload: modifiedPayload,
    });

    expect(res2.statusCode).toBe(422);
    expect(res2.json().error.code).toBe('IDEMPOTENCY_CONFLICT');
  });
});
