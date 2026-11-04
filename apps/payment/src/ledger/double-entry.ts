import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { ledgerEntries, type NewLedgerEntry } from '../db/schema';

export type LedgerAccount =
  'rider_receivable' | 'driver_payable' | 'platform_revenue' | 'cash_clearing';

export interface LedgerEntryDraft {
  account: LedgerAccount;
  debit: number; // minor units >= 0
  credit: number; // minor units >= 0
  rideId?: string;
  driverId?: string;
  description?: string;
}

export interface PostTransactionParams {
  txnId: string;
  entries: LedgerEntryDraft[];
  ts?: Date;
}

export class DoubleEntryLedger {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle db
  constructor(private db: any) {}

  /**
   * Posts balanced entries atomically in a single transaction.
   * Enforces debits == credits before inserting.
   */
  async postTransaction(params: PostTransactionParams): Promise<void> {
    const { txnId, entries, ts = new Date() } = params;

    if (entries.length === 0) {
      throw new Error(`Cannot post empty transaction for txnId ${txnId}`);
    }

    let totalDebit = 0;
    let totalCredit = 0;

    for (const e of entries) {
      if (e.debit < 0 || e.credit < 0) {
        throw new Error(`Negative debit or credit in entry for ${e.account} in txnId ${txnId}`);
      }
      if (e.debit > 0 && e.credit > 0) {
        throw new Error(
          `Entry for ${e.account} cannot have both positive debit and credit in txnId ${txnId}`,
        );
      }
      totalDebit += e.debit;
      totalCredit += e.credit;
    }

    if (totalDebit !== totalCredit) {
      throw new Error(
        `Ledger transaction ${txnId} is unbalanced: totalDebit=${totalDebit}, totalCredit=${totalCredit}`,
      );
    }

    const rows: NewLedgerEntry[] = entries.map((e) => ({
      id: randomUUID(),
      txnId,
      account: e.account,
      debit: e.debit,
      credit: e.credit,
      rideId: e.rideId ?? null,
      driverId: e.driverId ?? null,
      description: e.description ?? null,
      ts,
    }));

    // Insert entries atomically
    await this.db.insert(ledgerEntries).values(rows);
  }

  /**
   * Helper to record completed ride trip settlement.
   * Default platform commission is 20%.
   */
  async recordRideSettlement(params: {
    rideId: string;
    driverId?: string;
    fareMinorUnits: number;
    platformFeeRate?: number; // default 0.20 (20%)
    ts?: Date;
  }): Promise<string> {
    const txnId = `txn_ride_complete_${params.rideId}`;
    const feeRate = params.platformFeeRate ?? 0.2;
    const platformFee = Math.round(params.fareMinorUnits * feeRate);
    const driverPayable = params.fareMinorUnits - platformFee;

    await this.postTransaction({
      txnId,
      ts: params.ts,
      entries: [
        {
          account: 'rider_receivable',
          debit: params.fareMinorUnits,
          credit: 0,
          rideId: params.rideId,
          description: `Fare captured for ride ${params.rideId}`,
        },
        {
          account: 'driver_payable',
          debit: 0,
          credit: driverPayable,
          rideId: params.rideId,
          driverId: params.driverId,
          description: `Driver earnings for ride ${params.rideId}`,
        },
        {
          account: 'platform_revenue',
          debit: 0,
          credit: platformFee,
          rideId: params.rideId,
          description: `Platform take rate (${Math.round(feeRate * 100)}%) for ride ${params.rideId}`,
        },
      ],
    });

    return txnId;
  }

  /**
   * Helper to record full refund for a ride.
   */
  async recordRideRefund(params: {
    rideId: string;
    driverId?: string;
    fareMinorUnits: number;
    platformFeeRate?: number;
    ts?: Date;
  }): Promise<string> {
    const txnId = `txn_ride_refund_${params.rideId}`;
    const feeRate = params.platformFeeRate ?? 0.2;
    const platformFee = Math.round(params.fareMinorUnits * feeRate);
    const driverPayable = params.fareMinorUnits - platformFee;

    await this.postTransaction({
      txnId,
      ts: params.ts,
      entries: [
        {
          account: 'rider_receivable',
          debit: 0,
          credit: params.fareMinorUnits,
          rideId: params.rideId,
          description: `Refund issued for ride ${params.rideId}`,
        },
        {
          account: 'driver_payable',
          debit: driverPayable,
          credit: 0,
          rideId: params.rideId,
          driverId: params.driverId,
          description: `Reversal of driver earnings for refunded ride ${params.rideId}`,
        },
        {
          account: 'platform_revenue',
          debit: platformFee,
          credit: 0,
          rideId: params.rideId,
          description: `Reversal of platform commission for refunded ride ${params.rideId}`,
        },
      ],
    });

    return txnId;
  }

  /**
   * Helper to record driver payout settlement.
   */
  async recordDriverPayout(params: {
    payoutId: string;
    driverId: string;
    amountMinorUnits: number;
    ts?: Date;
  }): Promise<string> {
    const txnId = `txn_payout_${params.payoutId}`;

    await this.postTransaction({
      txnId,
      ts: params.ts,
      entries: [
        {
          account: 'driver_payable',
          debit: params.amountMinorUnits,
          credit: 0,
          driverId: params.driverId,
          description: `Disbursement of driver payout ${params.payoutId}`,
        },
        {
          account: 'cash_clearing',
          debit: 0,
          credit: params.amountMinorUnits,
          driverId: params.driverId,
          description: `Cash clearing transfer for payout ${params.payoutId}`,
        },
      ],
    });

    return txnId;
  }

  /**
   * Helper to record rider cancellation fee.
   */
  async recordCancellationFee(params: {
    rideId: string;
    feeMinorUnits: number;
    ts?: Date;
  }): Promise<string> {
    const txnId = `txn_cancel_fee_${params.rideId}`;

    await this.postTransaction({
      txnId,
      ts: params.ts,
      entries: [
        {
          account: 'rider_receivable',
          debit: params.feeMinorUnits,
          credit: 0,
          rideId: params.rideId,
          description: `Cancellation fee charged for ride ${params.rideId}`,
        },
        {
          account: 'platform_revenue',
          debit: 0,
          credit: params.feeMinorUnits,
          rideId: params.rideId,
          description: `Platform fee for cancellation on ride ${params.rideId}`,
        },
      ],
    });

    return txnId;
  }
}

/**
 * Asserts the fundamental double-entry invariant:
 * 1. For every txn_id, total debits == total credits.
 * 2. Globally across all entries, sum(debit) == sum(credit).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle db
export async function assertLedgerInvariant(db: any): Promise<void> {
  // 1. Check per-transaction balance
  const unbalancedTxns = await db
    .select({
      txnId: ledgerEntries.txnId,
      totalDebit: sql<number>`sum(${ledgerEntries.debit})`,
      totalCredit: sql<number>`sum(${ledgerEntries.credit})`,
    })
    .from(ledgerEntries)
    .groupBy(ledgerEntries.txnId)
    .having(sql`sum(${ledgerEntries.debit}) <> sum(${ledgerEntries.credit})`);

  if (unbalancedTxns.length > 0) {
    const first = unbalancedTxns[0]!;
    throw new Error(
      `Ledger invariant violated for txn ${first.txnId}: debits=${first.totalDebit}, credits=${first.totalCredit}`,
    );
  }

  // 2. Check global sum of debits and credits
  const globalSum = await db
    .select({
      totalDebit: sql<number>`coalesce(sum(${ledgerEntries.debit}), 0)`,
      totalCredit: sql<number>`coalesce(sum(${ledgerEntries.credit}), 0)`,
    })
    .from(ledgerEntries);

  const row = globalSum[0] ?? { totalDebit: 0, totalCredit: 0 };
  const net = Number(row.totalDebit) - Number(row.totalCredit);
  if (net !== 0) {
    throw new Error(
      `Global ledger invariant violated! Global debits=${row.totalDebit}, global credits=${row.totalCredit}, diff=${net}`,
    );
  }
}
