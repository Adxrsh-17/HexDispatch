import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import RedisMock from 'ioredis-mock';
import Fastify, { type FastifyInstance } from 'fastify';
import { createTestDb } from './test-db';
import { offers, matchDecisions } from '../src/db/schema';
import { DriverClaimService } from '../src/services/driver-claim';
import { MatchingRegistry } from '../src/services/matching-registry';
import { OfferManager } from '../src/services/offer-manager';
import { DispatchEngine } from '../src/services/dispatch-engine';
import { TOPICS, type RideRequestedEvent } from '@hexdispatch/contracts';

type TestDbResult = Awaited<ReturnType<typeof createTestDb>>;

describe('Dispatch Concurrency & Anti-Double-Assignment (AC2 & AC5)', () => {
  let dbResult: TestDbResult;
  let redis: InstanceType<typeof RedisMock>;
  let claimService: DriverClaimService;
  let offerManager: OfferManager;
  let dispatchEngine: DispatchEngine;
  let mockLocationApp: FastifyInstance;
  let mockCoreApp: FastifyInstance;

  const mockDrivers = [
    { driverId: randomUUID(), lat: 12.9716, lng: 77.5946, ts: new Date().toISOString() },
    { driverId: randomUUID(), lat: 12.972, lng: 77.595, ts: new Date().toISOString() },
    { driverId: randomUUID(), lat: 12.973, lng: 77.596, ts: new Date().toISOString() },
  ];

  beforeAll(async () => {
    dbResult = await createTestDb();
    redis = new RedisMock();

    // Mock Location service returning the 3 drivers
    mockLocationApp = Fastify();
    mockLocationApp.get('/drivers/nearby', async () => mockDrivers);
    const locAddr = await mockLocationApp.listen({ host: '127.0.0.1', port: 0 });

    // Mock Core API
    mockCoreApp = Fastify();
    mockCoreApp.post('/rides/:id/transition', async () => ({ status: 'ok' }));
    const coreAddr = await mockCoreApp.listen({ host: '127.0.0.1', port: 0 });

    claimService = new DriverClaimService(redis);
    const matchingRegistry = new MatchingRegistry();

    offerManager = new OfferManager({
      db: dbResult.db,
      redis,
      claimService,
      coreApiUrl: coreAddr,
      defaultOfferTimeoutSec: 10,
    });

    dispatchEngine = new DispatchEngine({
      db: dbResult.db,
      offerManager,
      matchingRegistry,
      claimService,
      coreApiUrl: coreAddr,
      locationUrl: locAddr,
      matchingPolicy: 'greedy',
      maxOfferAttempts: 2,
    });
  });

  afterAll(async () => {
    offerManager.stop();
    await mockLocationApp.close();
    await mockCoreApp.close();
    await dbResult.clean();
  });

  it('10 simultaneous ride requests with 3 drivers never double-assigns a driver', async () => {
    const rideEvents: RideRequestedEvent[] = [];

    // Create 10 concurrent ride requests
    for (let i = 0; i < 10; i++) {
      const rideId = randomUUID();
      rideEvents.push({
        eventId: randomUUID(),
        type: TOPICS.RIDE_REQUESTED,
        version: 1,
        occurredAt: new Date().toISOString(),
        correlationId: randomUUID(),
        payload: {
          rideId,
          riderId: randomUUID(),
          pickup: { lat: 12.9716, lng: 77.5946 },
          dropoff: { lat: 12.98, lng: 77.6 },
          pickupCell: '88618925d3fffff',
          vehicleType: 'sedan',
          requestedAt: new Date().toISOString(),
        },
      });
    }

    // Fire all 10 requests concurrently
    await Promise.all(rideEvents.map((evt) => dispatchEngine.handleRideRequested(evt)));

    // 1. Assert on active offers: exactly 3 offers must be created (since only 3 drivers exist)
    const allOffers = await dbResult.db.select().from(offers);
    const pendingOffers = allOffers.filter((o) => o.status === 'PENDING');

    expect(pendingOffers.length).toBeLessThanOrEqual(mockDrivers.length);
    expect(pendingOffers.length).toBe(3);

    // 2. Invariant: Every pending offer must be for a UNIQUE driver
    const offeredDrivers = new Set(pendingOffers.map((o) => o.driverId));
    expect(offeredDrivers.size).toBe(pendingOffers.length);

    // 3. Invariant: Each driver has at most 1 claim in Redis
    for (const d of mockDrivers) {
      const claim = await claimService.getClaim(d.driverId);
      expect(claim).not.toBeNull();
      expect(claim).toContain(':OFFER');
    }

    // 4. Concurrently accept all 3 offers
    const acceptPromises = pendingOffers.map((offer) =>
      offerManager.acceptOffer(offer.id, offer.driverId),
    );
    const acceptedOffers = await Promise.all(acceptPromises);
    expect(acceptedOffers).toHaveLength(3);

    // 5. Assert on match_decisions: exactly 3 rows, policy='greedy', no driver assigned twice
    const decisions = await dbResult.db.select().from(matchDecisions);
    expect(decisions).toHaveLength(3);

    const assignedDrivers = new Set(decisions.map((d) => d.driverId));
    const assignedRides = new Set(decisions.map((d) => d.rideId));

    // Every decision has policy = 'greedy' (AC5)
    for (const d of decisions) {
      expect(d.policy).toBe('greedy');
      expect(d.cost).toBeGreaterThanOrEqual(0);
      expect(d.batchId).toBeNull();
    }

    // Unique driver and unique ride per decision (AC2)
    expect(assignedDrivers.size).toBe(3);
    expect(assignedRides.size).toBe(3);

    // Invariant: Redis claims upgraded to TRIP
    for (const d of mockDrivers) {
      const claim = await claimService.getClaim(d.driverId);
      expect(claim).not.toBeNull();
      expect(claim).toContain(':TRIP');
    }
  });
});
