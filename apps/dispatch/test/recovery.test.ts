import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import RedisMock from 'ioredis-mock';
import Fastify, { type FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { createTestDb } from './test-db';
import { offers } from '../src/db/schema';
import { DriverClaimService } from '../src/services/driver-claim';
import { MatchingRegistry } from '../src/services/matching-registry';
import { OfferManager } from '../src/services/offer-manager';
import { DispatchEngine } from '../src/services/dispatch-engine';
import { TOPICS, type RideRequestedEvent } from '@hexdispatch/contracts';

type TestDbResult = Awaited<ReturnType<typeof createTestDb>>;

describe('Dispatch Recovery after Mid-Offer Crash (AC4)', () => {
  let dbResult: TestDbResult;
  let redis: InstanceType<typeof RedisMock>;
  let claimService: DriverClaimService;
  let offerManager: OfferManager;
  let dispatchEngine: DispatchEngine;
  let mockLocationApp: FastifyInstance;
  let mockCoreApp: FastifyInstance;
  let locAddr: string;
  let coreAddr: string;

  const driver1Id = randomUUID();
  const driver2Id = randomUUID();

  const mockDrivers = [
    { driverId: driver1Id, lat: 12.9716, lng: 77.5946, ts: new Date().toISOString() },
    { driverId: driver2Id, lat: 12.9726, lng: 77.5946, ts: new Date().toISOString() },
  ];

  beforeEach(async () => {
    dbResult = await createTestDb();
    redis = new RedisMock();
    await redis.flushall();

    mockLocationApp = Fastify();
    mockLocationApp.get('/drivers/nearby', async () => mockDrivers);
    locAddr = await mockLocationApp.listen({ host: '127.0.0.1', port: 0 });

    mockCoreApp = Fastify();
    mockCoreApp.post('/rides/:id/transition', async () => ({ status: 'ok' }));
    coreAddr = await mockCoreApp.listen({ host: '127.0.0.1', port: 0 });

    claimService = new DriverClaimService(redis);
    const matchingRegistry = new MatchingRegistry();

    offerManager = new OfferManager({
      db: dbResult.db,
      redis,
      claimService,
      coreApiUrl: coreAddr,
      defaultOfferTimeoutSec: 10,
      onReofferNeeded: async (rideId, excludedDriverId) => {
        await dispatchEngine.handleReofferNeeded(rideId, excludedDriverId);
      },
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

  afterEach(async () => {
    offerManager.stop();
    await mockLocationApp.close();
    await mockCoreApp.close();
    await dbResult.clean();
  });

  function createRideEvent(): RideRequestedEvent {
    const rideId = randomUUID();
    return {
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
    };
  }

  it('killing dispatch and restarting while offer is still valid re-arms timer and can be accepted', async () => {
    const rideEvent = createRideEvent();
    const rideId = rideEvent.payload.rideId;

    await dispatchEngine.handleRideRequested(rideEvent);

    const pendingOffers = await dbResult.db.select().from(offers).where(eq(offers.rideId, rideId));
    expect(pendingOffers).toHaveLength(1);
    const initialOffer = pendingOffers[0]!;
    expect(initialOffer.status).toBe('PENDING');

    // --- SIMULATE PROCESS CRASH: stop in-memory timers and destroy old instance ---
    offerManager.stop();

    // --- SIMULATE SERVICE RESTART: create new OfferManager & DispatchEngine on same DB/Redis ---
    const restartedOfferManager = new OfferManager({
      db: dbResult.db,
      redis,
      claimService,
      coreApiUrl: coreAddr,
      defaultOfferTimeoutSec: 10,
      onReofferNeeded: async (rId, excl) => {
        await restartedDispatchEngine.handleReofferNeeded(rId, excl);
      },
    });

    const restartedDispatchEngine = new DispatchEngine({
      db: dbResult.db,
      offerManager: restartedOfferManager,
      matchingRegistry: new MatchingRegistry(),
      claimService,
      coreApiUrl: coreAddr,
      locationUrl: locAddr,
    });

    // Run startup recovery
    const recoveryResult = await restartedOfferManager.recoverPendingOffers();
    expect(recoveryResult.recoveredCount).toBe(1);
    expect(recoveryResult.expiredCount).toBe(0);

    // The driver now accepts the re-armed offer
    const accepted = await restartedOfferManager.acceptOffer(
      initialOffer.id,
      initialOffer.driverId,
    );
    expect(accepted.status).toBe('ACCEPTED');

    restartedOfferManager.stop();
  });

  it('killing dispatch and restarting after offer expired cleans up claim and triggers re-offer', async () => {
    const rideEvent = createRideEvent();
    const rideId = rideEvent.payload.rideId;

    await dispatchEngine.handleRideRequested(rideEvent);

    const pendingOffers = await dbResult.db.select().from(offers).where(eq(offers.rideId, rideId));
    const initialOffer = pendingOffers[0]!;

    // --- SIMULATE PROCESS CRASH ---
    offerManager.stop();

    // Simulate time passing: update DB offer expiresAt to 5 seconds in the past
    const pastDate = new Date(Date.now() - 5000);
    await dbResult.db
      .update(offers)
      .set({ expiresAt: pastDate })
      .where(eq(offers.id, initialOffer.id));

    // --- SIMULATE SERVICE RESTART ---
    // eslint-disable-next-line prefer-const -- Initialized below after restartedOfferManager
    let restartedDispatchEngine: DispatchEngine;
    const restartedOfferManager = new OfferManager({
      db: dbResult.db,
      redis,
      claimService,
      coreApiUrl: coreAddr,
      defaultOfferTimeoutSec: 10,
      onReofferNeeded: async (rId, excl) => {
        await restartedDispatchEngine.handleReofferNeeded(rId, excl);
      },
    });

    restartedDispatchEngine = new DispatchEngine({
      db: dbResult.db,
      offerManager: restartedOfferManager,
      matchingRegistry: new MatchingRegistry(),
      claimService,
      coreApiUrl: coreAddr,
      locationUrl: locAddr,
    });

    // Re-register the active ride state so re-offer can continue
    restartedDispatchEngine.registerRideState({
      rideId,
      riderId: rideEvent.payload.riderId,
      pickup: rideEvent.payload.pickup,
      dropoff: rideEvent.payload.dropoff,
      vehicleType: rideEvent.payload.vehicleType,
      requestedAtMs: new Date(rideEvent.payload.requestedAt).getTime(),
      attempts: 1,
      excludedDriverIds: new Set<string>(),
    });

    // Run startup recovery
    const recoveryResult = await restartedOfferManager.recoverPendingOffers();
    expect(recoveryResult.expiredCount).toBe(1);

    // Offer 1 must be marked EXPIRED
    const offer1AfterRestart = await restartedOfferManager.getOfferById(initialOffer.id);
    expect(offer1AfterRestart?.status).toBe('EXPIRED');

    // Driver 1 claim must be released
    expect(await claimService.getClaim(driver1Id)).toBeNull();

    // Re-offer must have succeeded for Driver 2
    const allOffers = await dbResult.db.select().from(offers).where(eq(offers.rideId, rideId));
    expect(allOffers).toHaveLength(2);
    const offer2 = allOffers.find((o) => o.id !== initialOffer.id)!;
    expect(offer2.driverId).toBe(driver2Id);
    expect(offer2.status).toBe('PENDING');

    restartedOfferManager.stop();
  });
});
