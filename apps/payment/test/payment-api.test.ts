import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { withInternalAuth } from '@hexdispatch/shared';
import type { FastifyInstance } from 'fastify';
import { createTestDb } from './test-db';
import { DoubleEntryLedger, assertLedgerInvariant } from '../src/ledger/double-entry';
import { MockPspClient } from '../src/psp/mock-psp';
import { PaymentSagaService } from '../src/services/payment-saga';
import { ReconciliationService } from '../src/services/reconciliation';
import { buildPaymentApp } from '../src/app';

type TestDbResult = Awaited<ReturnType<typeof createTestDb>>;

describe('Payment Service REST API', () => {
  let dbResult: TestDbResult;
  let pspClient: MockPspClient;
  let ledger: DoubleEntryLedger;
  let sagaService: PaymentSagaService;
  let reconciler: ReconciliationService;
  let app: FastifyInstance;

  beforeEach(async () => {
    dbResult = await createTestDb();
    pspClient = new MockPspClient();
    ledger = new DoubleEntryLedger(dbResult.db);
    sagaService = new PaymentSagaService({
      db: dbResult.db,
      pspClient,
      ledger,
    });
    reconciler = new ReconciliationService(dbResult.db);

    app = withInternalAuth(
      await buildPaymentApp({
        db: dbResult.db,
        pspClient,
        sagaService,
        reconciliationService: reconciler,
        ledger,
        logLevel: 'silent',
      }),
    );
  });

  afterEach(async () => {
    await assertLedgerInvariant(dbResult.db);
    await app.close();
    await dbResult.clean();
  });

  it('GET /rides/:id/payment returns payment status, saga state, and ledger entries', async () => {
    const rideId = 'ride-api-1';
    await sagaService.startAuthorizeSaga(rideId, 5000);
    await sagaService.startCaptureSaga(rideId, 5000, 'drv-api-1');

    const res = await app.inject({
      method: 'GET',
      url: `/rides/${rideId}/payment`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.rideId).toBe(rideId);
    expect(body.payment.status).toBe('CAPTURED');
    expect(body.saga.state).toBe('COMPLETED');
    expect(body.ledgerEntries).toHaveLength(3);
  });

  it('POST /admin/reconcile runs reconciliation and returns report', async () => {
    const rideId = 'ride-api-recon';
    await sagaService.startAuthorizeSaga(rideId, 4500);
    await sagaService.startCaptureSaga(rideId, 4500, 'drv-recon-1');

    const res = await app.inject({
      method: 'POST',
      url: '/admin/reconcile',
    });

    expect(res.statusCode).toBe(200);
    const report = res.json();
    expect(report.matchedCount).toBe(1);
    expect(report.mismatchCount).toBe(0);
  });

  it('POST /admin/payouts/batch aggregates driver payables into paid payouts', async () => {
    // Two completed rides for driver drv-batch
    await sagaService.startAuthorizeSaga('ride-payout-1', 5000);
    await sagaService.startCaptureSaga('ride-payout-1', 5000, 'drv-batch');

    await sagaService.startAuthorizeSaga('ride-payout-2', 5000);
    await sagaService.startCaptureSaga('ride-payout-2', 5000, 'drv-batch');

    const res = await app.inject({
      method: 'POST',
      url: '/admin/payouts/batch',
      payload: {},
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.payouts).toHaveLength(1);
    // 80% of 10000 = 8000
    expect(body.payouts[0].amountMinorUnits).toBe(8000);
    expect(body.payouts[0].status).toBe('PAID');
  });

  it('POST /admin/refunds/:rideId executes refund and posts reversal entries', async () => {
    const rideId = 'ride-api-refund';
    await sagaService.startAuthorizeSaga(rideId, 7000);
    await sagaService.startCaptureSaga(rideId, 7000, 'drv-refund');

    const res = await app.inject({
      method: 'POST',
      url: `/admin/refunds/${rideId}`,
      payload: { reason: 'CUSTOMER_DISPUTE' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.refunded).toBe(true);

    const checkRes = await app.inject({
      method: 'GET',
      url: `/rides/${rideId}/payment`,
    });
    expect(checkRes.json().payment.status).toBe('REFUNDED');
    expect(checkRes.json().ledgerEntries).toHaveLength(6); // 3 for capture, 3 for refund reversal
  });
});
