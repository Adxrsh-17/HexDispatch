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

describe('Offers, Declines, Timeouts & Re-offer Lifecycle (AC3)', () => {
  let dbResult: TestDbResult;
  let redis: InstanceType<typeof RedisMock>;
  let claimService: DriverClaimService;
  let offerManager: OfferManager;
  let dispatchEngine: DispatchEngine;
  let mockLocationApp: FastifyInstance;
  let mockCoreApp: FastifyInstance;
  let locAddr: string;
  let coreAddr: string;
  const coreTransitions: Array<{ rideId: string; to: string; driverId?: string }> = [];

  const driver1Id = randomUUID();
  const driver2Id = randomUUID();
  const driver3Id = randomUUID();

  // Driver 1 closest (0m), Driver 2 farther (100m), Driver 3 farthest (500m)
  const mockDrivers = [
    { driverId: driver1Id, lat: 12.9716, lng: 77.5946, ts: new Date().toISOString() },
    { driverId: driver2Id, lat: 12.9726, lng: 77.5946, ts: new Date().toISOString() },
    { driverId: driver3Id, lat: 12.9766, lng: 77.5946, ts: new Date().toISOString() },
  ];

  beforeEach(async () => {
    coreTransitions.length = 0;
    dbResult = await createTestDb();
    redis = new RedisMock();
    await redis.flushall();

    mockLocationApp = Fastify();
    mockLocationApp.get('/drivers/nearby', async () => mockDrivers);
    locAddr = await mockLocationApp.listen({ host: '127.0.0.1', port: 0 });

    mockCoreApp = Fastify();
    mockCoreApp.post('/rides/:id/transition', async (req) => {
      const { id } = req.params as { id: string };
      const body = req.body as { to: string; driverId?: string };
      coreTransitions.push({ rideId: id, to: body.to, driverId: body.driverId });
      return { status: 'ok' };
    });
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

  function createRideEvent(rideId: string = randomUUID()): RideRequestedEvent {
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

  it('decline releases claim and re-offers to the next closest candidate', async () => {
    const rideEvent = createRideEvent();
    const rideId = rideEvent.payload.rideId;

    await dispatchEngine.handleRideRequested(rideEvent);

    // 1. Initial offer goes to Driver 1 (closest)
    const initialOffers = await dbResult.db.select().from(offers).where(eq(offers.rideId, rideId));
    expect(initialOffers).toHaveLength(1);
    expect(initialOffers[0]!.driverId).toBe(driver1Id);
    expect(initialOffers[0]!.status).toBe('PENDING');

    // Invariant: Driver 1 has active Redis claim
    expect(await claimService.getClaim(driver1Id)).not.toBeNull();

    // 2. Driver 1 declines
    await offerManager.declineOffer(initialOffers[0]!.id, driver1Id, 'Taking a break');

    // Invariant: Driver 1 claim released immediately
    expect(await claimService.getClaim(driver1Id)).toBeNull();

    // Invariant: Offer 1 status marked DECLINED
    const declinedOffer = await offerManager.getOfferById(initialOffers[0]!.id);
    expect(declinedOffer?.status).toBe('DECLINED');

    // 3. Invariant: Re-offer was triggered and sent to Driver 2 (second closest)
    const allRideOffers = await dbResult.db.select().from(offers).where(eq(offers.rideId, rideId));
    expect(allRideOffers).toHaveLength(2);

    const secondOffer = allRideOffers.find((o) => o.id !== initialOffers[0]!.id)!;
    expect(secondOffer.driverId).toBe(driver2Id);
    expect(secondOffer.status).toBe('PENDING');

    // Invariant: Driver 2 now holds the claim
    expect(await claimService.getClaim(driver2Id)).not.toBeNull();

    // 4. Driver 2 accepts
    const accepted = await offerManager.acceptOffer(secondOffer.id, driver2Id);
    expect(accepted.status).toBe('ACCEPTED');

    // Invariant: Driver 2 claim upgraded to TRIP
    const d2Claim = await claimService.getClaim(driver2Id);
    expect(d2Claim).toContain(':TRIP');

    // Invariant: core-api transitioned to ASSIGNED with driver2
    const assignedTransition = coreTransitions.find(
      (t) => t.rideId === rideId && t.to === 'ASSIGNED',
    );
    expect(assignedTransition).toBeDefined();
    expect(assignedTransition?.driverId).toBe(driver2Id);
  });

  it('timeout triggers expiry, releases claim, and re-offers with short TTL', async () => {
    const rideEvent = createRideEvent();
    const rideId = rideEvent.payload.rideId;

    // Use a short 100ms timeout for this test
    offerManager.stop();
    offerManager = new OfferManager({
      db: dbResult.db,
      redis,
      claimService,
      coreApiUrl: coreAddr,
      defaultOfferTimeoutSec: 0.1, // 100ms TTL
      onReofferNeeded: async (rId, excl) => {
        await dispatchEngine.handleReofferNeeded(rId, excl);
      },
    });

    dispatchEngine = new DispatchEngine({
      db: dbResult.db,
      offerManager,
      matchingRegistry: new MatchingRegistry(),
      claimService,
      coreApiUrl: coreAddr,
      locationUrl: locAddr,
      maxOfferAttempts: 2,
    });

    await dispatchEngine.handleRideRequested(rideEvent);

    // Initial offer to driver 1
    const initialOffers = await dbResult.db.select().from(offers).where(eq(offers.rideId, rideId));
    expect(initialOffers).toHaveLength(1);
    expect(initialOffers[0]!.driverId).toBe(driver1Id);

    // Wait 250ms for timeout to fire and re-offer to complete
    await new Promise((r) => setTimeout(r, 250));

    // Offer 1 must be EXPIRED
    const expiredOffer = await offerManager.getOfferById(initialOffers[0]!.id);
    expect(expiredOffer?.status).toBe('EXPIRED');

    // Driver 1 claim must be released
    expect(await claimService.getClaim(driver1Id)).toBeNull();

    // Re-offer must have been created for Driver 2
    const allRideOffers = await dbResult.db.select().from(offers).where(eq(offers.rideId, rideId));
    expect(allRideOffers.length).toBeGreaterThanOrEqual(2);
    expect(allRideOffers.some((o) => o.driverId === driver2Id)).toBe(true);
  });

  it('exhausting max offer attempts marks ride as NO_DRIVER_FOUND', async () => {
    const rideEvent = createRideEvent();
    const rideId = rideEvent.payload.rideId;

    await dispatchEngine.handleRideRequested(rideEvent);

    // Offer 1 -> Driver 1 declines
    const offer1 = (await dbResult.db.select().from(offers).where(eq(offers.rideId, rideId)))[0]!;
    await offerManager.declineOffer(offer1.id, driver1Id);

    // Offer 2 -> Driver 2 declines (reaches maxAttempts = 2)
    const allOffersRound2 = await dbResult.db
      .select()
      .from(offers)
      .where(eq(offers.rideId, rideId));
    const offer2 = allOffersRound2.find((o) => o.id !== offer1.id)!;
    await offerManager.declineOffer(offer2.id, driver2Id);

    // Invariant: No 3rd offer created because maxAttempts (2) reached
    const finalOffers = await dbResult.db.select().from(offers).where(eq(offers.rideId, rideId));
    expect(finalOffers).toHaveLength(2);

    // Invariant: Transitioned to NO_DRIVER_FOUND in core-api
    const noDriverTransition = coreTransitions.find(
      (t) => t.rideId === rideId && t.to === 'NO_DRIVER_FOUND',
    );
    expect(noDriverTransition).toBeDefined();
  });
});
