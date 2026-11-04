import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { TRIP_STATES, type TripState, type TripActor } from '@hexdispatch/contracts';
import {
  isTransitionLegal,
  transitionRide,
  TRIP_TRANSITIONS,
} from '../src/services/trip-state-machine';
import { createTestDb } from './test-db';
import { users, rides, rideEvents, outbox } from '../src/db/schema';
import { eq } from 'drizzle-orm';
import { AppError } from '@hexdispatch/shared';

type TestDbResult = Awaited<ReturnType<typeof createTestDb>>;

describe('Trip State Machine', () => {
  let db: TestDbResult['db'];
  let client: TestDbResult['client'];
  let riderId: string;

  beforeAll(async () => {
    const testDb = await createTestDb();
    db = testDb.db;
    client = testDb.client;

    // Seed a test rider
    const [user] = await db
      .insert(users)
      .values({
        email: 'rider@example.com',
        passwordHash: 'hash',
        role: 'RIDER',
      })
      .returning();
    riderId = user!.id;
  });

  afterAll(async () => {
    if (client) {
      await client.close();
    }
  });

  async function createTestRide(status: TripState, version = 0): Promise<string> {
    const [ride] = await db
      .insert(rides)
      .values({
        riderId,
        pickupLat: 12.9716,
        pickupLng: 77.5946,
        dropoffLat: 12.9352,
        dropoffLng: 77.6245,
        pickupCell: '88618925d3fffff',
        status,
        version,
        fareEstimate: 650,
      })
      .returning();
    return ride!.id;
  }

  describe('Table-driven all state pairs (12 x 12 = 144 pairs)', () => {
    const actors: TripActor[] = ['RIDER', 'DRIVER', 'SYSTEM', 'ADMIN'];

    for (const from of TRIP_STATES) {
      for (const to of TRIP_STATES) {
        it(`evaluates transition from ${from} to ${to}`, async () => {
          const legalRule = TRIP_TRANSITIONS.find((r) => r.from === from && r.to === to);

          if (!legalRule) {
            // Must be illegal for ALL actors
            for (const actor of actors) {
              expect(isTransitionLegal(from, to, actor)).toBe(false);
            }

            // In DB execution, must reject with AppError
            const rideId = await createTestRide(from, 0);
            await expect(
              // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle transaction type
              db.transaction((tx: any) => transitionRide(tx, rideId, to, 'SYSTEM', 0)),
            ).rejects.toThrow(AppError);
          } else {
            // At least one actor is legal
            expect(legalRule.actors.length).toBeGreaterThan(0);
            for (const actor of legalRule.actors) {
              expect(isTransitionLegal(from, to, actor)).toBe(true);
            }

            // Unauthorized actors must be rejected
            const illegalActors = actors.filter((a) => !legalRule.actors.includes(a));
            for (const unauthorizedActor of illegalActors) {
              expect(isTransitionLegal(from, to, unauthorizedActor)).toBe(false);
            }

            // In DB execution with authorized actor, succeeds
            const authorizedActor = legalRule.actors[0]!;
            const rideId = await createTestRide(from, 0);
            const updated = await db.transaction(
              // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle transaction type
              (tx: any) => transitionRide(tx, rideId, to, authorizedActor, 0),
            );

            expect(updated.status).toBe(to);
            expect(updated.version).toBe(1);

            // Audit event and outbox rows created
            const events = await db.select().from(rideEvents).where(eq(rideEvents.rideId, rideId));
            expect(events.length).toBe(1);
            expect(events[0]!.fromState).toBe(from);
            expect(events[0]!.toState).toBe(to);

            const outboxRows = await db.select().from(outbox).where(eq(outbox.aggregateId, rideId));
            expect(outboxRows.length).toBe(1);
          }
        });
      }
    }
  });

  describe('Concurrency & Optimistic Locking', () => {
    it('parallel conflicting updates leave a valid state and consistent history', async () => {
      const rideId = await createTestRide('REQUESTED', 0);

      // Two competing transitions attempting to mutate version 0
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle transaction type
      const attempt1 = db.transaction((tx: any) =>
        transitionRide(tx, rideId, 'MATCHING', 'SYSTEM', 0),
      );
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle transaction type
      const attempt2 = db.transaction((tx: any) =>
        transitionRide(tx, rideId, 'CANCELLED_BY_RIDER', 'RIDER', 0),
      );

      const results = await Promise.allSettled([attempt1, attempt2]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');

      // Exactly ONE succeeds, the other fails with optimistic lock conflict (409)
      expect(fulfilled.length).toBe(1);
      expect(rejected.length).toBe(1);

      const error = (rejected[0] as PromiseRejectedResult).reason;
      expect(error).toBeInstanceOf(AppError);
      expect(error.status).toBe(409);

      // Verify the database state is consistent
      const [finalRide] = await db.select().from(rides).where(eq(rides.id, rideId));
      expect(finalRide!.version).toBe(1);
      expect(['MATCHING', 'CANCELLED_BY_RIDER']).toContain(finalRide!.status);

      // Verify ride_events contains exactly 1 event row for the successful transition
      const events = await db.select().from(rideEvents).where(eq(rideEvents.rideId, rideId));
      expect(events.length).toBe(1);
      expect(events[0]!.toState).toBe(finalRide!.status);
    });
  });
});
