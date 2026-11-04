import { pgTable, text, integer, timestamp, uuid, jsonb, index } from 'drizzle-orm/pg-core';

export const payments = pgTable(
  'payments',
  {
    id: uuid('id').primaryKey(),
    rideId: text('ride_id').notNull(),
    status: text('status').notNull(), // AUTHORIZED, CAPTURED, FAILED, REFUNDED, RELEASED
    amountMinorUnits: integer('amount_minor_units').notNull(),
    currency: text('currency').notNull().default('INR'),
    pspRef: text('psp_ref'),
    idempotencyKey: text('idempotency_key').notNull().unique(),
    metadata: jsonb('metadata'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_payments_ride_id').on(table.rideId),
    index('idx_payments_status').on(table.status),
  ],
);

export const paymentSagas = pgTable(
  'payment_sagas',
  {
    rideId: text('ride_id').primaryKey(),
    step: text('step').notNull(), // AUTHORIZE, CAPTURE, REFUND, RELEASE, COMPLETED, FAILED
    state: text('state').notNull(), // PENDING, EXECUTING, COMPLETED, COMPENSATING, FAILED
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(5),
    payload: jsonb('payload'),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('idx_sagas_state').on(table.state), index('idx_sagas_step').on(table.step)],
);

export const ledgerEntries = pgTable(
  'ledger_entries',
  {
    id: uuid('id').primaryKey(),
    txnId: text('txn_id').notNull(),
    account: text('account').notNull(), // rider_receivable, platform_revenue, driver_payable, platform_fee, cash_clearing
    debit: integer('debit').notNull().default(0), // minor units
    credit: integer('credit').notNull().default(0), // minor units
    rideId: text('ride_id'),
    driverId: text('driver_id'),
    description: text('description'),
    ts: timestamp('ts', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_ledger_txn_id').on(table.txnId),
    index('idx_ledger_account').on(table.account),
    index('idx_ledger_ride_id').on(table.rideId),
    index('idx_ledger_driver_id').on(table.driverId),
  ],
);

export const payouts = pgTable(
  'payouts',
  {
    id: uuid('id').primaryKey(),
    driverId: text('driver_id').notNull(),
    amountMinorUnits: integer('amount_minor_units').notNull(),
    currency: text('currency').notNull().default('INR'),
    status: text('status').notNull(), // PENDING, PROCESSING, PAID, FAILED
    statementId: text('statement_id'),
    metadata: jsonb('metadata'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_payouts_driver_id').on(table.driverId),
    index('idx_payouts_status').on(table.status),
  ],
);

export const pspRecords = pgTable(
  'psp_records',
  {
    id: uuid('id').primaryKey(),
    pspRef: text('psp_ref').notNull().unique(),
    rideId: text('ride_id').notNull(),
    idempotencyKey: text('idempotency_key').notNull().unique(),
    kind: text('kind').notNull(), // AUTHORIZATION, CAPTURE, REFUND, RELEASE
    amountMinorUnits: integer('amount_minor_units').notNull(),
    status: text('status').notNull(), // SUCCESS, FAILED, PENDING
    ts: timestamp('ts', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_psp_records_ride_id').on(table.rideId),
    index('idx_psp_records_kind').on(table.kind),
  ],
);

export const processedEvents = pgTable('processed_events', {
  eventId: text('event_id').primaryKey(),
  consumer: text('consumer').notNull(),
  processedAt: timestamp('processed_at', { withTimezone: true }).notNull().defaultNow(),
});

export type Payment = typeof payments.$inferSelect;
export type NewPayment = typeof payments.$inferInsert;
export type PaymentSaga = typeof paymentSagas.$inferSelect;
export type NewPaymentSaga = typeof paymentSagas.$inferInsert;
export type LedgerEntry = typeof ledgerEntries.$inferSelect;
export type NewLedgerEntry = typeof ledgerEntries.$inferInsert;
export type Payout = typeof payouts.$inferSelect;
export type NewPayout = typeof payouts.$inferInsert;
export type PspRecord = typeof pspRecords.$inferSelect;
export type NewPspRecord = typeof pspRecords.$inferInsert;
