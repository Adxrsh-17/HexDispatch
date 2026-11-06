/**
 * HexDispatch demo. Every line it prints is backed by an assertion on real state; if a check
 * fails the demo exits non-zero. Nothing here is canned.
 *
 * What runs for real: core-api, location, dispatch, gateway, payment saga + ledger, all in one
 * process. What is substituted (so the demo needs no Docker): Postgres -> PGlite, Redis ->
 * ioredis-mock, the Kafka hop between services -> direct calls, the PSP -> the in-memory mock PSP.
 */
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import RedisMock from 'ioredis-mock';
import { and, asc, eq } from 'drizzle-orm';
import {
  TOPICS,
  type RideRequestedEvent,
  type TripStateChangedEvent,
} from '../../packages/contracts/src';
import type { MatchingPolicy } from '../../packages/matching/src';
import { setupE2EEnvironment, runE2ERide } from './e2e-ride';
import { rides, rideEvents, outbox } from '../../apps/core-api/src/db/schema';
import { createTestDb as createPaymentDb } from '../../apps/payment/test/test-db';
import { createTestDb as createDispatchDb } from '../../apps/dispatch/test/test-db';
import { MockPspClient } from '../../apps/payment/src/psp/mock-psp';
import { PaymentSagaService } from '../../apps/payment/src/services/payment-saga';
import {
  DoubleEntryLedger,
  assertLedgerInvariant,
} from '../../apps/payment/src/ledger/double-entry';
import { payments, paymentSagas, pspRecords } from '../../apps/payment/src/db/schema';
import { offers } from '../../apps/dispatch/src/db/schema';
import { DriverClaimService } from '../../apps/dispatch/src/services/driver-claim';
import { MatchingRegistry } from '../../apps/dispatch/src/services/matching-registry';
import { OfferManager } from '../../apps/dispatch/src/services/offer-manager';
import { DispatchEngine } from '../../apps/dispatch/src/services/dispatch-engine';

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`DEMO CHECK FAILED: ${message}`);
  console.log(`   [ok] ${message}`);
}

function banner(title: string): void {
  console.log('\n========================================================================');
  console.log(`  ${title}`);
  console.log('========================================================================');
}

export async function runDemo(): Promise<void> {
  console.log('HexDispatch demo (in-process; PGlite + in-memory Redis + mock PSP)');

  // ---------------------------------------------------------------- Stages 1-2
  banner('STAGE 1-2: request -> match -> accept -> arrive -> start -> complete (via the gateway)');
  const env = await setupE2EEnvironment();
  let rideId: string;
  try {
    rideId = await runE2ERide(env.gatewayUrl);

    const [ride] = await env.coreDb.select().from(rides).where(eq(rides.id, rideId));
    const history = await env.coreDb
      .select()
      .from(rideEvents)
      .where(eq(rideEvents.rideId, rideId))
      .orderBy(asc(rideEvents.version));
    console.log(`   core-api state chain: ${history.map((e) => e.toState).join(' -> ')}`);
    check(ride?.status === 'COMPLETED', 'core-api says the ride is COMPLETED');
    check(history.length === 7, 'ride_events has the full 7-step chain');

    // ---------------------------------------------------------------- Stage 3
    banner('STAGE 3: payment saga on the REAL trip.state.changed events core-api wrote');
    const events = (
      await env.coreDb
        .select()
        .from(outbox)
        .where(and(eq(outbox.aggregateId, rideId), eq(outbox.topic, TOPICS.TRIP_STATE_CHANGED)))
        .orderBy(asc(outbox.createdAt))
    ).map((row) => row.payload as TripStateChangedEvent);
    check(events.length >= 6, `core-api outbox holds ${events.length} trip.state.changed events`);
    const assigned = events.find((e) => e.payload.to === 'ASSIGNED');
    const completed = events.find((e) => e.payload.to === 'COMPLETED');
    check(assigned && completed, 'outbox contains the ASSIGNED and COMPLETED events');

    const paymentDb = await createPaymentDb();
    const psp = new MockPspClient({ seed: 42 });
    const saga = new PaymentSagaService({
      db: paymentDb.db,
      pspClient: psp,
      ledger: new DoubleEntryLedger(paymentDb.db),
    });
    try {
      await saga.handleTripStateChanged(assigned!);
      console.log('   PSP now times out on every call; delivering COMPLETED (capture)...');
      psp.updateConfig({ timeoutRate: 1 });
      await saga.handleTripStateChanged(completed!);
      psp.updateConfig({ timeoutRate: 0 });

      const resumed = await saga.resumePendingSagas();
      console.log(`   resumePendingSagas() found ${resumed} unfinished saga(s)`);
      await saga.handleTripStateChanged(completed!); // duplicate delivery must be a no-op

      const [sagaRow] = await paymentDb.db
        .select()
        .from(paymentSagas)
        .where(eq(paymentSagas.rideId, rideId));
      check(sagaRow?.state === 'COMPLETED', 'saga finished despite the PSP timeouts');
      const [payment] = await paymentDb.db
        .select()
        .from(payments)
        .where(eq(payments.rideId, rideId));
      check(payment?.status === 'CAPTURED', 'payment is CAPTURED');
      const captures = (
        await paymentDb.db.select().from(pspRecords).where(eq(pspRecords.rideId, rideId))
      ).filter((r) => r.kind === 'CAPTURE');
      check(captures.length === 1, 'exactly one CAPTURE exists at the PSP (no double charge)');
      await assertLedgerInvariant(paymentDb.db);
      check(true, 'double-entry ledger invariant holds (debits == credits)');
      console.log(
        `   NOTE: captured amount is ${payment?.amountMinorUnits} minor units. trip.state.changed does not carry the fare yet, so the saga uses its placeholder amount. Known gap, see docs/REVIEW.md problem 7.`,
      );
    } finally {
      await paymentDb.clean();
    }
  } finally {
    await env.close();
  }

  // ---------------------------------------------------------------- Stage 4
  banner('STAGE 4: the batched solver throws -> dispatch falls back to greedy for that window');
  const db = await createDispatchDb();
  const redis = new RedisMock();
  const driverId = randomUUID();
  const core = Fastify();
  const transitions: string[] = [];
  core.post('/rides/:id/transition', async (req) => {
    transitions.push((req.body as { to: string }).to);
    return { ok: true };
  });
  const location = Fastify();
  location.get('/drivers/nearby', async () => [
    { driverId, lat: 12.9716, lng: 77.5946, ts: new Date().toISOString() },
  ]);
  const coreUrl = await core.listen({ host: '127.0.0.1', port: 0 });
  const locUrl = await location.listen({ host: '127.0.0.1', port: 0 });

  const registry = new MatchingRegistry();
  const broken: MatchingPolicy = {
    name: 'batched',
    match: () => {
      throw new Error('simulated solver crash');
    },
  };
  registry.register(broken);
  const claims = new DriverClaimService(redis as never);
  const offerManager = new OfferManager({
    db: db.db,
    redis: redis as never,
    claimService: claims,
    coreApiUrl: coreUrl,
  });
  const engine = new DispatchEngine({
    db: db.db,
    offerManager,
    matchingRegistry: registry,
    claimService: claims,
    coreApiUrl: coreUrl,
    locationUrl: locUrl,
    matchingPolicy: 'batched',
    batchWindowMs: 0,
  });
  try {
    const rideRequested: RideRequestedEvent = {
      eventId: randomUUID(),
      type: TOPICS.RIDE_REQUESTED,
      version: 1,
      occurredAt: new Date().toISOString(),
      correlationId: 'demo',
      payload: {
        rideId: randomUUID(),
        riderId: randomUUID(),
        pickup: { lat: 12.972, lng: 77.595 },
        dropoff: { lat: 12.935, lng: 77.624 },
        pickupCell: 'demo',
        vehicleType: 'sedan',
        requestedAt: new Date().toISOString(),
      },
    };
    await engine.handleRideRequested(rideRequested);
    const result = await engine.runBatchCycle();
    check(result.fallback === true, 'the window reports that it used the fallback');
    const rows = await db.db
      .select()
      .from(offers)
      .where(eq(offers.rideId, rideRequested.payload.rideId));
    check(rows.length === 1, 'the rider still received an offer');
    check(rows[0]?.policy === 'greedy', 'the offer was produced by the greedy policy');
    check(transitions.includes('OFFERED'), 'core-api was moved to OFFERED');
  } finally {
    offerManager.stop();
    engine.stop();
    await core.close();
    await location.close();
    await db.clean();
  }

  console.log('\nDemo finished: every check above passed.');
}

if (process.argv[1]?.includes('demo')) {
  runDemo()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
