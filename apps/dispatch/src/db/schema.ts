import { pgTable, uuid, varchar, integer, doublePrecision, timestamp } from 'drizzle-orm/pg-core';

export const offers = pgTable('offers', {
  id: uuid('id').primaryKey().defaultRandom(),
  rideId: uuid('ride_id').notNull(),
  driverId: uuid('driver_id').notNull(),
  status: varchar('status', { length: 32 }).notNull().default('PENDING'),
  pickupEtaSec: integer('pickup_eta_sec').notNull(),
  cost: doublePrecision('cost').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export const matchDecisions = pgTable('match_decisions', {
  id: uuid('id').primaryKey().defaultRandom(),
  rideId: uuid('ride_id').notNull(),
  driverId: uuid('driver_id').notNull(),
  policy: varchar('policy', { length: 64 }).notNull(),
  cost: doublePrecision('cost').notNull(),
  batchId: uuid('batch_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const processedEvents = pgTable('processed_events', {
  eventId: uuid('event_id').primaryKey(),
  eventType: varchar('event_type', { length: 64 }).notNull(),
  processedAt: timestamp('processed_at', { withTimezone: true }).defaultNow().notNull(),
});

export type Offer = typeof offers.$inferSelect;
export type NewOffer = typeof offers.$inferInsert;
export type MatchDecision = typeof matchDecisions.$inferSelect;
export type NewMatchDecision = typeof matchDecisions.$inferInsert;
