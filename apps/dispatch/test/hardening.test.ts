import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import RedisMock from 'ioredis-mock';
import Fastify, { type FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { TOPICS, type RideRequestedEvent } from '@hexdispatch/contracts';
import type { MatchingPolicy } from '@hexdispatch/matching';
import { createTestDb } from './test-db';
import { offers, matchDecisions } from '../src/db/schema';
import { DriverClaimService } from '../src/services/driver-claim';
import { MatchingRegistry } from '../src/services/matching-registry';
import { OfferManager } from '../src/services/offer-manager';
import { DispatchEngine } from '../src/services/dispatch-engine';
import { RideStateError } from '../src/services/core-client';

interface CoreRide {
  id: string;
  riderId: string;
  status: string;
  pickupLat: number;
  pickupLng: number;
  dropoffLat: number;
  dropoffLng: number;
  createdAt: string;
}

const PICKUP = { lat: 12.9716, lng: 77.5946 };

function rideEvent(rideId: string, requestedAt = new Date()): RideRequestedEvent {
  return {
    eventId: randomUUID(),
    type: TOPICS.RIDE_REQUESTED,
    version: 1,
    occurredAt: new Date().toISOString(),
    correlationId: 'test',
    payload: {
      rideId,
      riderId: randomUUID(),
      pickup: PICKUP,
      dropoff: { lat: 12.93, lng: 77.62 },
      pickupCell: 'cell',
      vehicleType: 'sedan',
      requestedAt: requestedAt.toISOString(),
    },
  };
}

function coreRide(id: string, status: string, createdAt = new Date()): CoreRide {
  return {
    id,
    riderId: randomUUID(),
    status,
    pickupLat: PICKUP.lat,
    pickupLng: PICKUP.lng,
    dropoffLat: 12.93,
    dropoffLng: 77.62,
    createdAt: createdAt.toISOString(),
  };
}

const drivers = () => [
  { driverId: randomUUID(), lat: 12.9716, lng: 77.5946, ts: new Date().toISOString() },
  { driverId: randomUUID(), lat: 12.9717, lng: 77.5947, ts: new Date().toISOString() },
  { driverId: randomUUID(), lat: 12.9718, lng: 77.5948, ts: new Date().toISOString() },
];

async function harness(
  opts: {
    drivers?: ReturnType<typeof drivers>;
    locationDelayMs?: number;
    rejectTransitionsTo?: string[];
    coreRides?: CoreRide[];
    engine?: Partial<ConstructorParameters<typeof DispatchEngine>[0]>;
    registry?: MatchingRegistry;
  } = {},
) {
  const db = await createTestDb();
  const redis = new RedisMock();
  const transitions: Array<{ rideId: string; to: string }> = [];
  const reject = new Set(opts.rejectTransitionsTo ?? []);
  const coreRides = opts.coreRides ?? [];

  const core: FastifyInstance = Fastify();
  core.post('/rides/:id/transition', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { to } = req.body as { to: string };
    transitions.push({ rideId: id, to });
    if (reject.has(to)) return reply.code(400).send({ error: { message: `illegal -> ${to}` } });
    return { status: to };
  });
  core.get('/rides/:id', async (req, reply) => {
    const found = coreRides.find((r) => r.id === (req.params as { id: string }).id);
    return found ? found : reply.code(404).send({});
  });
  core.get('/rides', async (req) => {
    const q = req.query as { status?: string; offset?: string; limit?: string };
    const matching = coreRides.filter((r) => r.status === q.status);
    const offset = Number(q.offset ?? 0);
    return matching.slice(offset, offset + Number(q.limit ?? 100));
  });

  const location: FastifyInstance = Fastify();
  const driverList = opts.drivers ?? drivers();
  location.get('/drivers/nearby', async () => {
    if (opts.locationDelayMs) await new Promise((r) => setTimeout(r, opts.locationDelayMs));
    return driverList;
  });

  const coreUrl = await core.listen({ host: '127.0.0.1', port: 0 });
  const locUrl = await location.listen({ host: '127.0.0.1', port: 0 });

  const claims = new DriverClaimService(redis as never);
  const reoffers: Array<{ rideId: string; driverId: string }> = [];
  const gone: string[] = [];
  // eslint-disable-next-line prefer-const -- forward reference
  let engine: DispatchEngine;
  const offerManager = new OfferManager({
    db: db.db,
    redis: redis as never,
    claimService: claims,
    coreApiUrl: coreUrl,
    defaultOfferTimeoutSec: 30,
    onReofferNeeded: async (rideId, driverId) => {
      reoffers.push({ rideId, driverId });
    },
    onRideGone: (rideId) => {
      gone.push(rideId);
      engine?.dropRide(rideId);
    },
  });
  engine = new DispatchEngine({
    db: db.db,
    offerManager,
    matchingRegistry: opts.registry ?? new MatchingRegistry(),
    claimService: claims,
    coreApiUrl: coreUrl,
    locationUrl: locUrl,
    matchingPolicy: 'batched',
    batchWindowMs: 0, // cycles are driven by the tests
    maxOfferAttempts: 3,
    ...opts.engine,
  });

  return {
    db,
    claims,
    offerManager,
    engine,
    transitions,
    reoffers,
    gone,
    drivers: driverList,
    close: async () => {
      offerManager.stop();
      engine.stop();
      await core.close();
      await location.close();
      await db.clean();
    },
  };
}

let current: Awaited<ReturnType<typeof harness>> | undefined;
afterEach(async () => {
  await current?.close();
  current = undefined;
});

describe('offer lifecycle is race-free (review problem 4)', () => {
  it('accept vs expire fired together: exactly one wins, loser has no side effects (x40)', async () => {
    current = await harness();
    const h = current;
    let accepted = 0;
    let expired = 0;

    for (let i = 0; i < 40; i++) {
      const rideId = randomUUID();
      const driverId = randomUUID();
      const offer = await h.offerManager.createOffer({
        rideId,
        driverId,
        pickup: PICKUP,
        dropoff: PICKUP,
        pickupEtaSec: 10,
        cost: 1,
      });
      const reoffersBefore = h.reoffers.length;

      await Promise.allSettled([
        h.offerManager.acceptOffer(offer!.id, driverId),
        h.offerManager.expireOffer(offer!.id),
      ]);

      const [row] = await h.db.db.select().from(offers).where(eq(offers.id, offer!.id));
      const decisions = await h.db.db
        .select()
        .from(matchDecisions)
        .where(eq(matchDecisions.rideId, rideId));
      const newReoffers = h.reoffers.length - reoffersBefore;

      if (row?.status === 'ACCEPTED') {
        accepted++;
        expect(decisions).toHaveLength(1);
        expect(newReoffers).toBe(0); // an accepted offer must never trigger a re-offer
      } else {
        expired++;
        expect(row?.status).toBe('EXPIRED');
        expect(decisions).toHaveLength(0); // an expired offer must never record a match
        expect(newReoffers).toBe(1);
      }
    }
    expect(accepted + expired).toBe(40);
  });

  it('accept vs decline fired together: never both a match and a re-offer', async () => {
    current = await harness();
    const h = current;
    for (let i = 0; i < 20; i++) {
      const rideId = randomUUID();
      const driverId = randomUUID();
      const offer = await h.offerManager.createOffer({
        rideId,
        driverId,
        pickup: PICKUP,
        dropoff: PICKUP,
        pickupEtaSec: 10,
        cost: 1,
      });
      const before = h.reoffers.length;
      await Promise.allSettled([
        h.offerManager.acceptOffer(offer!.id, driverId),
        h.offerManager.declineOffer(offer!.id, driverId),
      ]);
      const decisions = await h.db.db
        .select()
        .from(matchDecisions)
        .where(eq(matchDecisions.rideId, rideId));
      expect(decisions.length + (h.reoffers.length - before)).toBe(1);
    }
  });

  it('createOffer moves the ride MATCHING -> OFFERED in core-api, accept moves it to ASSIGNED', async () => {
    current = await harness();
    const h = current;
    const rideId = randomUUID();
    const driverId = randomUUID();
    const offer = await h.offerManager.createOffer({
      rideId,
      driverId,
      pickup: PICKUP,
      dropoff: PICKUP,
      pickupEtaSec: 10,
      cost: 1,
    });
    await h.offerManager.acceptOffer(offer!.id, driverId);
    expect(h.transitions.map((t) => t.to)).toEqual(['OFFERED', 'ASSIGNED']);
  });

  it('if core-api refuses ASSIGNED the accept fails cleanly: offer FAILED, claim released, no match', async () => {
    current = await harness({ rejectTransitionsTo: ['ASSIGNED'] });
    const h = current;
    const rideId = randomUUID();
    const driverId = randomUUID();
    const offer = await h.offerManager.createOffer({
      rideId,
      driverId,
      pickup: PICKUP,
      dropoff: PICKUP,
      pickupEtaSec: 10,
      cost: 1,
    });

    await expect(h.offerManager.acceptOffer(offer!.id, driverId)).rejects.toMatchObject({
      status: 409,
    });
    const [row] = await h.db.db.select().from(offers).where(eq(offers.id, offer!.id));
    expect(row?.status).toBe('FAILED');
    expect(await h.claims.getClaim(driverId)).toBeNull();
    expect(
      await h.db.db.select().from(matchDecisions).where(eq(matchDecisions.rideId, rideId)),
    ).toHaveLength(0);
    expect(h.gone).toContain(rideId);
  });

  it('if core-api refuses OFFERED the offer is rolled back and the ride is dropped', async () => {
    current = await harness({ rejectTransitionsTo: ['OFFERED'] });
    const h = current;
    const rideId = randomUUID();
    const driverId = randomUUID();
    await expect(
      h.offerManager.createOffer({
        rideId,
        driverId,
        pickup: PICKUP,
        dropoff: PICKUP,
        pickupEtaSec: 10,
        cost: 1,
      }),
    ).rejects.toBeInstanceOf(RideStateError);
    expect(await h.claims.getClaim(driverId)).toBeNull();
    expect(h.gone).toContain(rideId);
  });

  it('claim acquisition has no non-atomic fallback: Redis errors propagate', async () => {
    const failing = {
      eval: async () => {
        throw new Error('redis down');
      },
      get: async () => {
        throw new Error('fallback must not be used');
      },
    };
    const claims = new DriverClaimService(failing as never);
    await expect(claims.acquireClaim('d1', 'o1')).rejects.toThrow('redis down');
  });
});

describe('batched dispatch under load, restart and failure (review problems 4-5)', () => {
  it('overlapping batch cycles never create two offers for one ride', async () => {
    current = await harness({ locationDelayMs: 120 });
    const h = current;
    const rideId = randomUUID();
    await h.engine.handleRideRequested(rideEvent(rideId));

    await Promise.all([
      h.engine.runBatchCycle(),
      h.engine.runBatchCycle(),
      h.engine.runBatchCycle(),
    ]);

    const rows = await h.db.db.select().from(offers).where(eq(offers.rideId, rideId));
    expect(rows).toHaveLength(1);
  });

  it('a batched ride that finds no driver becomes NO_DRIVER_FOUND instead of waiting forever', async () => {
    current = await harness({ drivers: [], engine: { matchingTimeoutMs: 40 } });
    const h = current;
    const rideId = randomUUID();
    await h.engine.handleRideRequested(rideEvent(rideId));

    await h.engine.runBatchCycle();
    expect(h.transitions.map((t) => t.to)).not.toContain('NO_DRIVER_FOUND'); // still within deadline

    await new Promise((r) => setTimeout(r, 80));
    await h.engine.runBatchCycle();
    expect(h.transitions.map((t) => t.to)).toContain('NO_DRIVER_FOUND');
    expect(h.engine.getActiveRide(rideId)).toBeUndefined();
  });

  it('the deadline counts from the ride creation time, so it survives a dispatch restart', async () => {
    const old = coreRide(randomUUID(), 'MATCHING', new Date(Date.now() - 120_000));
    current = await harness({
      drivers: [],
      coreRides: [old],
      engine: { matchingTimeoutMs: 60_000 },
    });
    const h = current;
    const { recovered } = await h.engine.recoverPendingRides();
    expect(recovered).toBe(1);
    await h.engine.runBatchCycle();
    expect(h.transitions).toContainEqual({ rideId: old.id, to: 'NO_DRIVER_FOUND' });
  });

  it('a fresh process recovers MATCHING rides from core-api and dispatches them', async () => {
    const waiting = coreRide(randomUUID(), 'MATCHING');
    current = await harness({ coreRides: [waiting] });
    const h = current;
    expect(h.engine.getActiveRide(waiting.id)).toBeUndefined(); // nothing in memory

    const { recovered } = await h.engine.recoverPendingRides();
    expect(recovered).toBe(1);

    await h.engine.runBatchCycle();
    const rows = await h.db.db.select().from(offers).where(eq(offers.rideId, waiting.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('PENDING');
  });

  it('recovery moves REQUESTED rides to MATCHING first', async () => {
    const fresh = coreRide(randomUUID(), 'REQUESTED');
    current = await harness({ coreRides: [fresh] });
    const h = current;
    await h.engine.recoverPendingRides();
    expect(h.transitions[0]).toEqual({ rideId: fresh.id, to: 'MATCHING' });
  });

  it('after a restart a declined offer still re-queues the ride (state rebuilt from core + offers)', async () => {
    const r = coreRide(randomUUID(), 'MATCHING');
    current = await harness({ coreRides: [r] });
    const h = current;
    const declinedBy = randomUUID();
    await h.engine.handleReofferNeeded(r.id, declinedBy); // engine has no in-memory state for r
    const state = h.engine.getActiveRide(r.id);
    expect(state).toBeDefined();
    expect(state?.excludedDriverIds.has(declinedBy)).toBe(true);
  });

  it('a solver that throws falls back to greedy for that window; nothing is stranded', async () => {
    const registry = new MatchingRegistry();
    const exploding: MatchingPolicy = {
      name: 'batched',
      match: () => {
        throw new Error('solver exploded');
      },
    };
    registry.register(exploding);
    current = await harness({ registry });
    const h = current;

    const rideId = randomUUID();
    await h.engine.handleRideRequested(rideEvent(rideId));
    const result = await h.engine.runBatchCycle();

    expect(result.fallback).toBe(true);
    expect(result.assignmentsCount).toBe(1);
    const rows = await h.db.db.select().from(offers).where(eq(offers.rideId, rideId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.policy).toBe('greedy');
    expect((await h.engine.batchErrorCounter.get()).values[0]?.value).toBe(1);
  });

  it('a slow solve switches later windows to greedy for a cooldown', async () => {
    const registry = new MatchingRegistry();
    registry.register({
      name: 'batched',
      match: () => {
        const end = Date.now() + 30;
        while (Date.now() < end) {
          /* burn 30 ms */
        }
        return { assignments: [], unmatchedRideIds: [] };
      },
    });
    current = await harness({
      registry,
      engine: { batchSolveBudgetMs: 5, degradeCooldownMs: 60_000 },
    });
    const h = current;

    await h.engine.handleRideRequested(rideEvent(randomUUID()));
    const first = await h.engine.runBatchCycle();
    expect(first.fallback).toBe(false); // the slow window itself finished on the batched policy

    await h.engine.handleRideRequested(rideEvent(randomUUID()));
    const second = await h.engine.runBatchCycle();
    expect(second.fallback).toBe(true);
  });
});
