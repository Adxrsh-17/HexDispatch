import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createTestDb } from './test-db';
import { DoubleEntryLedger, assertLedgerInvariant } from '../src/ledger/double-entry';
import { ReconciliationService } from '../src/services/reconciliation';
import { pspRecords } from '../src/db/schema';

type TestDbResult = Awaited<ReturnType<typeof createTestDb>>;

describe('Reconciliation Service (AC3)', () => {
  let dbResult: TestDbResult;
  let ledger: DoubleEntryLedger;
  let reconciler: ReconciliationService;

  beforeEach(async () => {
    dbResult = await createTestDb();
    ledger = new DoubleEntryLedger(dbResult.db);
    reconciler = new ReconciliationService(dbResult.db);
  });

  afterEach(async () => {
    await assertLedgerInvariant(dbResult.db);
    await dbResult.clean();
  });

  it('detects all 4 kinds of deliberately injected reconciliation mismatches', async () => {
    const db = dbResult.db;
    // 1. Matched Pair: ride-normal ($50 in PSP, $50 in ledger)
    const pspNormal = `psp_cap_normal_${randomUUID().slice(0, 6)}`;
    await db.insert(pspRecords).values({
      id: randomUUID(),
      pspRef: pspNormal,
      rideId: 'ride-normal',
      idempotencyKey: 'cap:ride-normal',
      kind: 'CAPTURE',
      amountMinorUnits: 5000,
      status: 'SUCCESS',
      ts: new Date(),
    });
    await ledger.recordRideSettlement({
      rideId: 'ride-normal',
      fareMinorUnits: 5000,
    });

    // 2. Injected Mismatch: MISSING_IN_LEDGER (in PSP records, missing in ledger)
    const pspMissingLedger = `psp_cap_orphan_${randomUUID().slice(0, 6)}`;
    await db.insert(pspRecords).values({
      id: randomUUID(),
      pspRef: pspMissingLedger,
      rideId: 'ride-missing-ledger',
      idempotencyKey: 'cap:ride-missing-ledger',
      kind: 'CAPTURE',
      amountMinorUnits: 7500,
      status: 'SUCCESS',
      ts: new Date(),
    });

    // 3. Injected Mismatch: MISSING_IN_PSP (in ledger, missing in PSP)
    await ledger.recordRideSettlement({
      rideId: 'ride-missing-psp',
      fareMinorUnits: 4000,
    });

    // 4. Injected Mismatch: AMOUNT_MISMATCH (PSP has $60, ledger has $65)
    const pspAmountDiff = `psp_cap_diff_${randomUUID().slice(0, 6)}`;
    await db.insert(pspRecords).values({
      id: randomUUID(),
      pspRef: pspAmountDiff,
      rideId: 'ride-amount-diff',
      idempotencyKey: 'cap:ride-amount-diff',
      kind: 'CAPTURE',
      amountMinorUnits: 6000,
      status: 'SUCCESS',
      ts: new Date(),
    });
    await ledger.recordRideSettlement({
      rideId: 'ride-amount-diff',
      fareMinorUnits: 6500,
    });

    // 5. Injected Mismatch: DUPLICATE_PSP_RECORD (2 captures for same ride)
    await db.insert(pspRecords).values([
      {
        id: randomUUID(),
        pspRef: `psp_cap_dup_1_${randomUUID().slice(0, 6)}`,
        rideId: 'ride-duplicate-psp',
        idempotencyKey: 'cap:ride-dup-1',
        kind: 'CAPTURE',
        amountMinorUnits: 3000,
        status: 'SUCCESS',
        ts: new Date(),
      },
      {
        id: randomUUID(),
        pspRef: `psp_cap_dup_2_${randomUUID().slice(0, 6)}`,
        rideId: 'ride-duplicate-psp',
        idempotencyKey: 'cap:ride-dup-2',
        kind: 'CAPTURE',
        amountMinorUnits: 3000,
        status: 'SUCCESS',
        ts: new Date(),
      },
    ]);
    await ledger.recordRideSettlement({
      rideId: 'ride-duplicate-psp',
      fareMinorUnits: 3000,
    });

    // Execute reconciliation
    const report = await reconciler.runReconciliation();

    expect(report.matchedCount).toBe(1); // ride-normal matched

    const missingInLedger = report.mismatches.find((m) => m.kind === 'MISSING_IN_LEDGER');
    expect(missingInLedger).toBeDefined();
    expect(missingInLedger?.rideId).toBe('ride-missing-ledger');
    expect(missingInLedger?.pspAmountMinorUnits).toBe(7500);

    const missingInPsp = report.mismatches.find((m) => m.kind === 'MISSING_IN_PSP');
    expect(missingInPsp).toBeDefined();
    expect(missingInPsp?.rideId).toBe('ride-missing-psp');
    expect(missingInPsp?.ledgerAmountMinorUnits).toBe(4000);

    const amountMismatch = report.mismatches.find((m) => m.kind === 'AMOUNT_MISMATCH');
    expect(amountMismatch).toBeDefined();
    expect(amountMismatch?.rideId).toBe('ride-amount-diff');
    expect(amountMismatch?.pspAmountMinorUnits).toBe(6000);
    expect(amountMismatch?.ledgerAmountMinorUnits).toBe(6500);

    const duplicatePsp = report.mismatches.find((m) => m.kind === 'DUPLICATE_PSP_RECORD');
    expect(duplicatePsp).toBeDefined();
    expect(duplicatePsp?.rideId).toBe('ride-duplicate-psp');
  });
});
