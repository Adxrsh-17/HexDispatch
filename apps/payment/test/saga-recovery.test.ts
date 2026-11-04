import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb } from './test-db';
import { DoubleEntryLedger, assertLedgerInvariant } from '../src/ledger/double-entry';
import { MockPspClient } from '../src/psp/mock-psp';
import { PaymentSagaService } from '../src/services/payment-saga';
import { payments, paymentSagas, pspRecords } from '../src/db/schema';
import { eq } from 'drizzle-orm';

type TestDbResult = Awaited<ReturnType<typeof createTestDb>>;

describe('Payment Saga Mid-Crash Recovery (AC4)', () => {
  let dbResult: TestDbResult;
  let pspClient: MockPspClient;
  let ledger: DoubleEntryLedger;
  let sagaService: PaymentSagaService;

  beforeEach(async () => {
    dbResult = await createTestDb();
    pspClient = new MockPspClient();
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

  it('resumes from a crash during AUTHORIZE step without duplicate PSP effects', async () => {
    const db = dbResult.db;
    const rideId = 'ride-crash-auth-1';

    // Simulate crash after saga record inserted as PENDING
    await db.insert(paymentSagas).values({
      rideId,
      step: 'AUTHORIZE',
      state: 'PENDING',
      attempts: 1,
      payload: { amountMinorUnits: 4500 },
      updatedAt: new Date(),
    });

    // Reboot / resume pending sagas
    const resumed = await sagaService.resumePendingSagas();
    expect(resumed).toBe(1);

    // Verify payment is now AUTHORIZED
    const [payment] = await db.select().from(payments).where(eq(payments.rideId, rideId));
    expect(payment).toBeDefined();
    expect(payment!.status).toBe('AUTHORIZED');

    // Run recovery again (idempotent resume check)
    const resumedAgain = await sagaService.resumePendingSagas();
    expect(resumedAgain).toBe(0);

    // Assert only one PSP authorization record was created
    const pspRecs = await db.select().from(pspRecords).where(eq(pspRecords.rideId, rideId));
    expect(pspRecs).toHaveLength(1);
    expect(pspRecs[0]!.kind).toBe('AUTHORIZATION');
  });

  it('resumes from a crash during CAPTURE step and posts balanced ledger entries once', async () => {
    const db = dbResult.db;
    const rideId = 'ride-crash-cap-1';

    // 1. Authorize ride
    await sagaService.startAuthorizeSaga(rideId, 6000);

    // 2. Simulate crash during CAPTURE (state stuck at EXECUTING)
    await db
      .update(paymentSagas)
      .set({
        step: 'CAPTURE',
        state: 'EXECUTING',
        payload: { amountMinorUnits: 6000, driverId: 'drv-cap-1' },
      })
      .where(eq(paymentSagas.rideId, rideId));

    // 3. Restart consumer / resume
    const resumed = await sagaService.resumePendingSagas();
    expect(resumed).toBe(1);

    // Verify payment is CAPTURED
    const [payment] = await db.select().from(payments).where(eq(payments.rideId, rideId));
    expect(payment).toBeDefined();
    expect(payment!.status).toBe('CAPTURED');

    // Verify saga is COMPLETED
    const [saga] = await db.select().from(paymentSagas).where(eq(paymentSagas.rideId, rideId));
    expect(saga).toBeDefined();
    expect(saga!.state).toBe('COMPLETED');

    // Verify exactly one CAPTURE in psp_records
    const captures = (
      await db.select().from(pspRecords).where(eq(pspRecords.rideId, rideId))
    ).filter((r) => r.kind === 'CAPTURE');
    expect(captures).toHaveLength(1);
  });
});
