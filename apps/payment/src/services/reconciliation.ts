import { eq, sql } from 'drizzle-orm';
import { pspRecords, ledgerEntries, type PspRecord } from '../db/schema';

export interface ReconciliationMismatch {
  kind: 'MISSING_IN_LEDGER' | 'MISSING_IN_PSP' | 'AMOUNT_MISMATCH' | 'DUPLICATE_PSP_RECORD';
  rideId: string;
  pspAmountMinorUnits?: number;
  ledgerAmountMinorUnits?: number;
  description: string;
}

export interface ReconciliationReport {
  reconciledAt: string;
  totalPspRecords: number;
  totalLedgerRides: number;
  matchedCount: number;
  mismatchCount: number;
  mismatches: ReconciliationMismatch[];
}

export class ReconciliationService {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle db
  constructor(private db: any) {}

  async runReconciliation(): Promise<ReconciliationReport> {
    const mismatches: ReconciliationMismatch[] = [];

    // 1. Fetch all successful CAPTURE records from psp_records
    const pspCaptures = await this.db
      .select()
      .from(pspRecords)
      .where(eq(pspRecords.kind, 'CAPTURE'));

    // Check for duplicate PSP captures per ride
    const pspMap = new Map<string, typeof pspCaptures>();
    for (const rec of pspCaptures) {
      const existing = pspMap.get(rec.rideId) ?? [];
      existing.push(rec);
      pspMap.set(rec.rideId, existing);
    }

    for (const [rideId, records] of pspMap.entries()) {
      if (records.length > 1) {
        mismatches.push({
          kind: 'DUPLICATE_PSP_RECORD',
          rideId,
          pspAmountMinorUnits: records.reduce(
            (s: number, r: PspRecord) => s + r.amountMinorUnits,
            0,
          ),
          description: `Found ${records.length} duplicate PSP capture records for ride ${rideId}`,
        });
      }
    }

    // 2. Fetch all ledger settlements (debit on rider_receivable)
    const ledgerSettlements = await this.db
      .select({
        rideId: ledgerEntries.rideId,
        totalDebit: sql<number>`sum(${ledgerEntries.debit})`,
      })
      .from(ledgerEntries)
      .where(eq(ledgerEntries.account, 'rider_receivable'))
      .groupBy(ledgerEntries.rideId);

    const ledgerMap = new Map<string, number>();
    for (const l of ledgerSettlements) {
      if (l.rideId) {
        ledgerMap.set(l.rideId, Number(l.totalDebit));
      }
    }

    let matchedCount = 0;

    // 3. Compare PSP -> Ledger
    for (const [rideId, records] of pspMap.entries()) {
      const pspTotal = records.reduce((s: number, r: PspRecord) => s + r.amountMinorUnits, 0);
      const ledgerTotal = ledgerMap.get(rideId);

      if (ledgerTotal === undefined) {
        mismatches.push({
          kind: 'MISSING_IN_LEDGER',
          rideId,
          pspAmountMinorUnits: pspTotal,
          description: `Ride ${rideId} exists in PSP records ($${(pspTotal / 100).toFixed(2)}) but has no ledger settlement entry`,
        });
      } else if (pspTotal !== ledgerTotal) {
        mismatches.push({
          kind: 'AMOUNT_MISMATCH',
          rideId,
          pspAmountMinorUnits: pspTotal,
          ledgerAmountMinorUnits: ledgerTotal,
          description: `Amount mismatch for ride ${rideId}: PSP captured $${(pspTotal / 100).toFixed(2)}, but ledger recorded $${(ledgerTotal / 100).toFixed(2)}`,
        });
      } else {
        matchedCount++;
      }
    }

    // 4. Compare Ledger -> PSP (find MISSING_IN_PSP)
    for (const [rideId, ledgerTotal] of ledgerMap.entries()) {
      if (!pspMap.has(rideId)) {
        mismatches.push({
          kind: 'MISSING_IN_PSP',
          rideId,
          ledgerAmountMinorUnits: ledgerTotal,
          description: `Ride ${rideId} has ledger settlement ($${(ledgerTotal / 100).toFixed(2)}) but no PSP capture record exists`,
        });
      }
    }

    return {
      reconciledAt: new Date().toISOString(),
      totalPspRecords: pspCaptures.length,
      totalLedgerRides: ledgerMap.size,
      matchedCount,
      mismatchCount: mismatches.length,
      mismatches,
    };
  }
}
