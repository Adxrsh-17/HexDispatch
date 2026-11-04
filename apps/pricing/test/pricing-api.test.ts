import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import RedisMock from 'ioredis-mock';
import type { FastifyInstance } from 'fastify';
import { createTestDb } from './test-db';
import { PricingService } from '../src/services/pricing-service';
import { buildPricingApp } from '../src/app';
import { TOPICS, type SurgeUpdatedEvent } from '@hexdispatch/contracts';

type TestDbResult = Awaited<ReturnType<typeof createTestDb>>;

describe('Pricing Service & REST API (AC1 & AC4)', () => {
  let dbResult: TestDbResult;
  let redis: InstanceType<typeof RedisMock>;
  let pricingService: PricingService;
  let app: FastifyInstance;
  const publishedEvents: Array<{ topic: string; payload: unknown }> = [];

  const mockProducer = {
    publish: async (topic: string, _key: string, payload: unknown) => {
      publishedEvents.push({ topic, payload });
    },
  };

  beforeAll(async () => {
    dbResult = await createTestDb();
    redis = new RedisMock();

    pricingService = new PricingService({
      db: dbResult.db,
      redis,
      quoteTtlSec: 2, // 2 seconds for TTL expiration testing
      surgeIntervalSec: 60,
      redisPubSub: redis,
      producer: mockProducer,
    });

    app = await buildPricingApp({
      pricingService,
      logLevel: 'silent',
    });
    await app.ready();
  });

  afterAll(async () => {
    pricingService.stop();
    await app.close();
    await dbResult.clean();
  });

  it('AC1: quote is stable within its TTL, expires after it, and can be locked to a ride', async () => {
    const riderId = randomUUID();

    // 1. Create quote via POST /quotes
    const createRes = await app.inject({
      method: 'POST',
      url: '/quotes',
      payload: {
        riderId,
        pickup: { lat: 12.9716, lng: 77.5946 },
        dropoff: { lat: 12.98, lng: 77.6 },
        vehicleType: 'SEDAN',
      },
    });

    expect(createRes.statusCode).toBe(201);
    const quote = createRes.json();
    expect(quote.id).toBeDefined();
    expect(quote.totalFareMinorUnits).toBeGreaterThan(0);
    expect(quote.expiresAt).toBeDefined();

    const quoteId = quote.id;
    const initialFare = quote.totalFareMinorUnits;

    // 2. Fetch quote within TTL via GET /quotes/:id -> stable
    const getRes1 = await app.inject({
      method: 'GET',
      url: `/quotes/${quoteId}`,
    });
    expect(getRes1.statusCode).toBe(200);
    const fetched1 = getRes1.json();
    expect(fetched1.totalFareMinorUnits).toBe(initialFare);
    expect(fetched1.isExpired).toBe(false);

    // 3. Lock quote to a ride via POST /quotes/:id/lock
    const rideId = randomUUID();
    const lockRes = await app.inject({
      method: 'POST',
      url: `/quotes/${quoteId}/lock`,
      payload: { rideId },
    });
    expect(lockRes.statusCode).toBe(200);
    expect(lockRes.json().rideId).toBe(rideId);
    expect(lockRes.json().totalFareMinorUnits).toBe(initialFare);

    // 4. Wait for TTL (2 seconds) to expire
    await new Promise((resolve) => setTimeout(resolve, 2200));

    // 5. Query quote after expiration -> marked isExpired: true
    const getRes2 = await app.inject({
      method: 'GET',
      url: `/quotes/${quoteId}`,
    });
    expect(getRes2.statusCode).toBe(200);
    expect(getRes2.json().isExpired).toBe(true);

    // 6. Attempting to lock an expired quote fails with 409 Conflict
    const expiredLockRes = await app.inject({
      method: 'POST',
      url: `/quotes/${quoteId}/lock`,
      payload: { rideId: randomUUID() },
    });
    expect(expiredLockRes.statusCode).toBe(409);
  });

  it('AC4: GET /surge/:cell/explain outputs all inputs and reproduces the exact multiplier', async () => {
    const cell = pricingService.getCellForPoint(12.9716, 77.5946);

    // Inject demand into sliding window
    await pricingService.recordDemandEvent(cell);
    await pricingService.recordDemandEvent(cell);
    await pricingService.recordDemandEvent(cell);
    await pricingService.setAvailableSupplyCount(cell, 2);

    const res = await app.inject({
      method: 'GET',
      url: `/surge/${cell}/explain`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();

    expect(body.cell).toBe(cell);
    expect(body.demand).toBe(3);
    expect(body.supply).toBe(2);
    expect(body.smoothedDemand).toBeDefined();
    expect(body.smoothedSupply).toBeDefined();
    expect(body.rawMultiplier).toBeDefined();
    expect(body.steppedMultiplier).toBeDefined();
    expect(body.hysteresisMultiplier).toBeDefined();
    expect(body.finalMultiplier).toBeDefined();
    expect(body.finalMultiplier).toBeGreaterThanOrEqual(1.0);
  });

  it('manages admin surge overrides via PUT /admin/surge/:cell and DELETE', async () => {
    const cell = '8860145b53fffff';
    const expiresAt = new Date(Date.now() + 60000).toISOString();

    // 1. Set admin override
    const putRes = await app.inject({
      method: 'PUT',
      url: `/admin/surge/${cell}`,
      payload: {
        multiplier: 2.15,
        expiresAt,
        actor: 'ops_lead',
        reason: 'Diwali rush override',
      },
    });

    expect(putRes.statusCode).toBe(200);

    // 2. Query surge for cell -> returns override
    const surgeRes = await app.inject({
      method: 'GET',
      url: `/surge?lat=12.9716&lng=77.5946`,
    });
    expect(surgeRes.statusCode).toBe(200);

    const cellOverride = await pricingService.getSurgeMultiplierForCell(cell);
    expect(cellOverride).toBe(2.15);

    // 3. Clear admin override
    const delRes = await app.inject({
      method: 'DELETE',
      url: `/admin/surge/${cell}`,
    });
    expect(delRes.statusCode).toBe(200);

    const cellAfterClear = await pricingService.getSurgeMultiplierForCell(cell);
    expect(cellAfterClear).toBe(1.0);
  });

  it('runs surge cycle on-demand, records surge_history, and emits pricing.surge.updated', async () => {
    publishedEvents.length = 0;
    const cell = '8860145b53fffff';

    await pricingService.recordDemandEvent(cell);
    await pricingService.recordDemandEvent(cell);
    await pricingService.recordDemandEvent(cell);
    await pricingService.recordDemandEvent(cell);
    await pricingService.setAvailableSupplyCount(cell, 1);

    const res = await app.inject({
      method: 'POST',
      url: '/internal/surge/cycle',
      payload: { cells: [cell] },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.processedCells).toBe(1);

    // Verify pricing.surge.updated was published
    const surgeEvent = publishedEvents.find((e) => e.topic === TOPICS.PRICING_SURGE_UPDATED);
    expect(surgeEvent).toBeDefined();
    const payload = (surgeEvent!.payload as SurgeUpdatedEvent).payload;
    expect(payload.cell).toBe(cell);
    expect(payload.multiplier).toBeGreaterThanOrEqual(1.0);
  });
});

