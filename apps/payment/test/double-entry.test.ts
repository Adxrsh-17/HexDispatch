import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb } from './test-db';
import { DoubleEntryLedger, assertLedgerInvariant } from '../src/ledger/double-entry';
import { ledgerEntries } from '../src/db/schema';

type TestDbResult = Awaited<ReturnType<typeof createTestDb>>;

describe('Double-Entry Ledger (AC2)', () => {
  let dbResult: TestDbResult;
  let ledger: DoubleEntryLedger;

  beforeEach(async () => {
    dbResult = await createTestDb();
    ledger = new DoubleEntryLedger(dbResult.db);
  });

  afterEach(async () => {
    await assertLedgerInvariant(dbResult.db);
    await dbResult.clean();
  });

  it('posts a balanced ride settlement with 20% platform commission', async () => {
    const rideId = 'ride-101';
    const driverId = 'drv-201';
    const fareMinorUnits = 10000; // 100.00

    const txnId = await ledger.recordRideSettlement({
      rideId,
      driverId,
      fareMinorUnits,
      platformFeeRate: 0.2,
    });

    expect(txnId).toBe(`txn_ride_complete_${rideId}`);

    const entries = await dbResult.db.select().from(ledgerEntries);
    expect(entries).toHaveLength(3);

    const receivable = entries.find((e) => e.account === 'rider_receivable');
    const payable = entries.find((e) => e.account === 'driver_payable');
    const revenue = entries.find((e) => e.account === 'platform_revenue');

    expect(receivable?.debit).toBe(10000);
    expect(receivable?.credit).toBe(0);

    expect(payable?.debit).toBe(0);
    expect(payable?.credit).toBe(8000); // 80%

    expect(revenue?.debit).toBe(0);
    expect(revenue?.credit).toBe(2000); // 20%
  });

  it('rejects unbalanced transactions before committing', async () => {
    await expect(
      ledger.postTransaction({
        txnId: 'txn-unbalanced',
        entries: [
          { account: 'rider_receivable', debit: 5000, credit: 0 },
          { account: 'driver_payable', debit: 0, credit: 4000 },
        ],
      }),
    ).rejects.toThrow(/unbalanced/i);

    const entries = await dbResult.db.select().from(ledgerEntries);
    expect(entries).toHaveLength(0);
  });

  it('posts driver payout settlement and maintains ledger invariant', async () => {
    // 1. Earn fare
    await ledger.recordRideSettlement({
      rideId: 'ride-102',
      driverId: 'drv-202',
      fareMinorUnits: 5000,
    });

    // 2. Disburse payout of 4000 (80%)
    const payoutTxn = await ledger.recordDriverPayout({
      payoutId: 'payout-1',
      driverId: 'drv-202',
      amountMinorUnits: 4000,
    });
    expect(payoutTxn).toBe('txn_payout_payout-1');

    const entries = await dbResult.db.select().from(ledgerEntries);
    expect(entries).toHaveLength(5);
  });

  it('posts refund and full reversal of earnings and commission', async () => {
    const rideId = 'ride-103';
    await ledger.recordRideSettlement({
      rideId,
      driverId: 'drv-203',
      fareMinorUnits: 6000,
      platformFeeRate: 0.2,
    });

    await ledger.recordRideRefund({
      rideId,
      driverId: 'drv-203',
      fareMinorUnits: 6000,
      platformFeeRate: 0.2,
    });

    const entries = await dbResult.db.select().from(ledgerEntries);
    expect(entries).toHaveLength(6);
  });
});
