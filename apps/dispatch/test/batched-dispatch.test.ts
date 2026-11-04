import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import RedisMock from 'ioredis-mock';
import Fastify, { type FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { createTestDb } from './test-db';
import { offers, matchDecisions } from '../src/db/schema';
import { DriverClaimService } from '../src/services/driver-claim';
import { MatchingRegistry } from '../src/services/matching-registry';
import { OfferManager } from '../src/services/offer-manager';
import { DispatchEngine } from '../src/services/dispatch-engine';
import {
  TOPICS,
  type RideRequestedEvent,
  type DispatchBatchCompletedEvent,
} from '@hexdispatch/contracts';

type TestDbResult = Awaited<ReturnType<typeof createTestDb>>;

describe('Batched Matching & Region Sharding in Dispatch (AC2 & AC5)', () => {
  let dbResult: TestDbResult;
  let redis: InstanceType<typeof RedisMock>;
  let claimService: DriverClaimService;
  let offerManager: OfferManager;
  let matchingRegistry: MatchingRegistry;
  let mockLocationApp: FastifyInstance;
  let mockCoreApp: FastifyInstance;
  let locAddr: string;
  let coreAddr: string;

  // Mock drivers positioned in Bangalore
  const mockDrivers = [
    { driverId: randomUUID(), lat: 12.9716, lng: 77.5946, ts: new Date().toISOString() },
    { driverId: randomUUID(), lat: 12.972, lng: 77.595, ts: new Date().toISOString() },
    { driverId: randomUUID(), lat: 12.973, lng: 77.596, ts: new Date().toISOString() },
  ];

  beforeAll(async () => {
    dbResult = await createTestDb();
    redis = new RedisMock();

    mockLocationApp = Fastify();
    mockLocationApp.get('/drivers/nearby', async () => mockDrivers);
    locAddr = await mockLocationApp.listen({ host: '127.0.0.1', port: 0 });

    mockCoreApp = Fastify();
    mockCoreApp.post('/rides/:id/transition', async () => ({ status: 'ok' }));
    coreAddr = await mockCoreApp.listen({ host: '127.0.0.1', port: 0 });

    claimService = new DriverClaimService(redis);
    matchingRegistry = new MatchingRegistry();

    offerManager = new OfferManager({
      db: dbResult.db,
      redis,
      claimService,
      coreApiUrl: coreAddr,
      defaultOfferTimeoutSec: 10,
    });
  });

  afterAll(async () => {
    offerManager.stop();
    await mockLocationApp.close();
    await mockCoreApp.close();
    await dbResult.clean();
  });

  it('collects pending requests, runs batched matching, and assigns policy="batched" with batch_id', async () => {
    const publishedEvents: Array<{ topic: string; payload: unknown }> = [];
    const mockProducer = {
      publish: async (topic: string, _key: string, payload: unknown) => {
        publishedEvents.push({ topic, payload });
      },
    };

    const engine = new DispatchEngine({
      db: dbResult.db,
      offerManager,
      matchingRegistry,
      claimService,
      coreApiUrl: coreAddr,
      locationUrl: locAddr,
      matchingPolicy: 'batched',
      batchWindowMs: 0, // Manual cycle execution for deterministic testing
      producer: mockProducer,
    });

    const rideId1 = randomUUID();
    const rideId2 = randomUUID();

    const req1: RideRequestedEvent = {
      eventId: randomUUID(),
      type: TOPICS.RIDE_REQUESTED,
      version: 1,
      occurredAt: new Date().toISOString(),
      correlationId: rideId1,
      payload: {
        rideId: rideId1,
        riderId: randomUUID(),
        pickup: { lat: 12.9716, lng: 77.5946 },
        dropoff: { lat: 12.98, lng: 77.6 },
        pickupCell: '8860145b53fffff',
        vehicleType: 'SEDAN',
        requestedAt: new Date().toISOString(),
      },
    };

    const req2: RideRequestedEvent = {
      eventId: randomUUID(),
      type: TOPICS.RIDE_REQUESTED,
      version: 1,
      occurredAt: new Date().toISOString(),
      correlationId: rideId2,
      payload: {
        rideId: rideId2,
        riderId: randomUUID(),
        pickup: { lat: 12.972, lng: 77.5946 },
        dropoff: { lat: 12.98, lng: 77.6 },
        pickupCell: '8860145b53fffff',
        vehicleType: 'SEDAN',
        requestedAt: new Date().toISOString(),
      },
    };

    await engine.handleRideRequested(req1);
    await engine.handleRideRequested(req2);

    // Trigger batch cycle manually
    const batchResult = await engine.runBatchCycle();
    expect(batchResult.assignmentsCount).toBe(2);
    expect(batchResult.fallback).toBe(false);

    // Verify offers were created with policy = 'batched' and batch_id
    const offerRows = await dbResult.db.select().from(offers);
    const ride1Offer = offerRows.find((o) => o.rideId === rideId1);
    const ride2Offer = offerRows.find((o) => o.rideId === rideId2);

    expect(ride1Offer).toBeDefined();
    expect(ride1Offer?.policy).toBe('batched');
    expect(ride1Offer?.batchId).toBe(batchResult.batchId);

    expect(ride2Offer).toBeDefined();
    expect(ride2Offer?.policy).toBe('batched');
    expect(ride2Offer?.batchId).toBe(batchResult.batchId);

    // Simulate driver accepting the offer
    await offerManager.acceptOffer(ride1Offer!.id, ride1Offer!.driverId);

    // Verify match_decisions row
    const decisions = await dbResult.db
      .select()
      .from(matchDecisions)
      .where(eq(matchDecisions.rideId, rideId1));
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.policy).toBe('batched');
    expect(decisions[0]!.batchId).toBe(batchResult.batchId);

    // Verify dispatch.batch.completed event was published
    const batchCompleted = publishedEvents.find((e) => e.topic === TOPICS.DISPATCH_BATCH_COMPLETED);
    expect(batchCompleted).toBeDefined();
    const payload = (batchCompleted!.payload as DispatchBatchCompletedEvent).payload;
    expect(payload.batchId).toBe(batchResult.batchId);
    expect(payload.policy).toBe('batched');
    expect(payload.fallback).toBe(false);
    expect(payload.assignmentsCount).toBe(2);

    engine.stop();
  });

  it('AC2: No driver is ever assigned twice across regions in a stress test with concurrent matchers', async () => {
    // Clear previous offers and claims
    await redis.flushall();
    await dbResult.db.delete(offers);
    await dbResult.db.delete(matchDecisions);

    const engine1 = new DispatchEngine({
      db: dbResult.db,
      offerManager,
      matchingRegistry,
      claimService,
      coreApiUrl: coreAddr,
      locationUrl: locAddr,
      matchingPolicy: 'batched',
      batchWindowMs: 0,
    });

    const engine2 = new DispatchEngine({
      db: dbResult.db,
      offerManager,
      matchingRegistry,
      claimService,
      coreApiUrl: coreAddr,
      locationUrl: locAddr,
      matchingPolicy: 'batched',
      batchWindowMs: 0,
    });

    // 10 concurrent rides submitted across both engines competing for the 3 drivers
    const promises: Promise<unknown>[] = [];
    for (let i = 0; i < 5; i++) {
      const rideId = randomUUID();
      promises.push(
        engine1.handleRideRequested({
          eventId: randomUUID(),
          type: TOPICS.RIDE_REQUESTED,
          version: 1,
          occurredAt: new Date().toISOString(),
          correlationId: rideId,
          payload: {
            rideId,
            riderId: randomUUID(),
            pickup: { lat: 12.9716, lng: 77.5946 },
            dropoff: { lat: 12.98, lng: 77.6 },
            pickupCell: '8860145b53fffff',
            vehicleType: 'SEDAN',
            requestedAt: new Date().toISOString(),
          },
        }),
      );
    }

    for (let i = 0; i < 5; i++) {
      const rideId = randomUUID();
      promises.push(
        engine2.handleRideRequested({
          eventId: randomUUID(),
          type: TOPICS.RIDE_REQUESTED,
          version: 1,
          occurredAt: new Date().toISOString(),
          correlationId: rideId,
          payload: {
            rideId,
            riderId: randomUUID(),
            pickup: { lat: 12.972, lng: 77.5946 },
            dropoff: { lat: 12.98, lng: 77.6 },
            pickupCell: '8860145b53fffff',
            vehicleType: 'SEDAN',
            requestedAt: new Date().toISOString(),
          },
        }),
      );
    }

    await Promise.all(promises);

    // Run batch cycle concurrently on both engines!
    await Promise.all([engine1.runBatchCycle(), engine2.runBatchCycle()]);

    // Query all created offers
    const allOffers = await dbResult.db.select().from(offers);
    const assignedDrivers = allOffers.map((o) => o.driverId);
    const uniqueDrivers = new Set(assignedDrivers);

    // AC2 Assertion: No driver is assigned more than once
    expect(assignedDrivers.length).toBe(uniqueDrivers.size);
    expect(uniqueDrivers.size).toBeLessThanOrEqual(mockDrivers.length);

    engine1.stop();
    engine2.stop();
  });

  it('AC5: Fallback trigger when batched matcher fails or encounters lag executes greedy fallback without stuck requests', async () => {
    const publishedEvents: Array<{ topic: string; payload: unknown }> = [];
    const mockProducer = {
      publish: async (topic: string, _key: string, payload: unknown) => {
        publishedEvents.push({ topic, payload });
      },
    };

    // Clear previous offers and claims
    await redis.flushall();
    await dbResult.db.delete(offers);

    const engine = new DispatchEngine({
      db: dbResult.db,
      offerManager,
      matchingRegistry,
      claimService,
      coreApiUrl: coreAddr,
      locationUrl: locAddr,
      matchingPolicy: 'batched',
      batchWindowMs: 0,
      producer: mockProducer,
    });

    const rideId = randomUUID();
    await engine.handleRideRequested({
      eventId: randomUUID(),
      type: TOPICS.RIDE_REQUESTED,
      version: 1,
      occurredAt: new Date().toISOString(),
      correlationId: rideId,
      payload: {
        rideId,
        riderId: randomUUID(),
        pickup: { lat: 12.9716, lng: 77.5946 },
        dropoff: { lat: 12.98, lng: 77.6 },
        pickupCell: '8860145b53fffff',
        vehicleType: 'SEDAN',
        requestedAt: new Date().toISOString(),
      },
    });

    // Inject failure / force fallback
    engine.setForceFallback(true);

    const res = await engine.runBatchCycle();

    expect(res.fallback).toBe(true);
    expect(res.assignmentsCount).toBe(1);

    // Verify fallback counter incremented
    const metricValue = await engine.fallbackCounter.get();
    expect(metricValue.values[0]!.value).toBeGreaterThanOrEqual(1);

    // Verify offer created under fallback
    const allOffers = await dbResult.db.select().from(offers);
    const rideOffer = allOffers.find((o) => o.rideId === rideId);
    expect(rideOffer).toBeDefined();
    expect(rideOffer?.policy).toBe('greedy');

    // Verify batch completed event has fallback: true and policy: 'greedy'
    const batchCompleted = publishedEvents.find((e) => e.topic === TOPICS.DISPATCH_BATCH_COMPLETED);
    expect(batchCompleted).toBeDefined();
    const payload = (batchCompleted!.payload as DispatchBatchCompletedEvent).payload;
    expect(payload.fallback).toBe(true);
    expect(payload.policy).toBe('greedy');

    engine.stop();
  });
});
