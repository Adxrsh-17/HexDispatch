import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createTestDb } from './test-db';
import { DoubleEntryLedger, assertLedgerInvariant } from '../src/ledger/double-entry';
import { MockPspClient } from '../src/psp/mock-psp';
import { PaymentSagaService } from '../src/services/payment-saga';
import { payments, paymentSagas, pspRecords } from '../src/db/schema';
import { TOPICS, type TripStateChangedEvent } from '@hexdispatch/contracts';
import { eq } from 'drizzle-orm';

type TestDbResult = Awaited<ReturnType<typeof createTestDb>>;

describe('Payment Saga Chaos Test (AC1 & AC2)', () => {
  let dbResult: TestDbResult;
  let pspClient: MockPspClient;
  let ledger: DoubleEntryLedger;
  let sagaService: PaymentSagaService;

  beforeEach(async () => {
    dbResult = await createTestDb();
    // 25% timeout rate to stress-test timeout resolution and recovery
    pspClient = new MockPspClient({ seed: 42, timeoutRate: 0.25 });
    ledger = new DoubleEntryLedger(dbResult.db);
    sagaService = new PaymentSagaService({
      db: dbResult.db,
      pspClient,
      ledger,
    });
  });

  afterEach(async () => {
    await assertLedgerInvariant(dbResult.db);
    await dbResult.clean();
  });

  it('completes multi-ride chaos run with timeouts, retries, and duplicates with no lost and no double-captured payments', async () => {
    const db = dbResult.db;
    const rideCount = 30;
    const completedRides: string[] = [];
    const cancelledRides: string[] = [];

    // 1. Fire ASSIGNED events for all rides (some with duplicate events)
    for (let i = 1; i <= rideCount; i++) {
      const rideId = `ride-chaos-${i}`;
      const event: TripStateChangedEvent = {
        eventId: randomUUID(),
        type: TOPICS.TRIP_STATE_CHANGED,
        version: 1,
        occurredAt: new Date().toISOString(),
        correlationId: rideId,
        payload: {
          rideId,
          from: 'OFFERED',
          to: 'ASSIGNED',
          version: 1,
          actor: 'SYSTEM',
          fareEstimate: 5000 + i * 100,
        } as unknown as TripStateChangedEvent['payload'],
      };

      await sagaService.handleTripStateChanged(event);

      // Injected duplicate event
      if (i % 3 === 0) {
        await sagaService.handleTripStateChanged({
          ...event,
          eventId: randomUUID(), // same event or different eventId
        });
      }
    }

    // 2. Transition rides: 24 completed, 6 cancelled
    for (let i = 1; i <= rideCount; i++) {
      const rideId = `ride-chaos-${i}`;
      if (i <= 24) {
        completedRides.push(rideId);
        const event: TripStateChangedEvent = {
          eventId: randomUUID(),
          type: TOPICS.TRIP_STATE_CHANGED,
          version: 1,
          occurredAt: new Date().toISOString(),
          correlationId: rideId,
          payload: {
            rideId,
            from: 'IN_PROGRESS',
            to: 'COMPLETED',
            version: 2,
            actor: 'DRIVER',
            driverId: `drv-${(i % 5) + 1}`,
            fareFinal: 5000 + i * 100,
          } as unknown as TripStateChangedEvent['payload'],
        };

        await sagaService.handleTripStateChanged(event);

        // Injected duplicate completion
        if (i % 2 === 0) {
          await sagaService.handleTripStateChanged(event);
        }
      } else {
        cancelledRides.push(rideId);
        const event: TripStateChangedEvent = {
          eventId: randomUUID(),
          type: TOPICS.TRIP_STATE_CHANGED,
          version: 1,
          occurredAt: new Date().toISOString(),
          correlationId: rideId,
          payload: {
            rideId,
            from: 'ASSIGNED',
            to: 'CANCELLED_BY_RIDER',
            version: 2,
            actor: 'RIDER',
            cancellationFeeMinorUnits: 0,
          } as unknown as TripStateChangedEvent['payload'],
        };
        await sagaService.handleTripStateChanged(event);
      }
    }

    // 3. Resume any pending sagas caught in network retry loops
    await sagaService.resumePendingSagas();

    // --- Assertions for AC1 ---

    // Exactly 24 completed rides
    expect(completedRides).toHaveLength(24);

    for (const rideId of completedRides) {
      // 1. Assert payment status is CAPTURED
      const [payment] = await db.select().from(payments).where(eq(payments.rideId, rideId));
      expect(payment).toBeDefined();
      expect(payment!.status).toBe('CAPTURED');

      // 2. Assert saga state is COMPLETED
      const [saga] = await db.select().from(paymentSagas).where(eq(paymentSagas.rideId, rideId));
      expect(saga).toBeDefined();
      expect(saga!.state).toBe('COMPLETED');

      // 3. Assert exactly one CAPTURE record in psp_records (no double-capture!)
      const captures = (
        await db.select().from(pspRecords).where(eq(pspRecords.rideId, rideId))
      ).filter((r) => r.kind === 'CAPTURE');
      expect(captures).toHaveLength(1);
    }

    // Cancelled rides: holds released
    for (const rideId of cancelledRides) {
      const [payment] = await db.select().from(payments).where(eq(payments.rideId, rideId));
      expect(payment).toBeDefined();
      expect(payment!.status).toBe('RELEASED');
    }
  });
});
