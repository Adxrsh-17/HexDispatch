import { pgTable, uuid, varchar, integer, doublePrecision, timestamp } from 'drizzle-orm/pg-core';

export const quotes = pgTable('quotes', {
  id: uuid('id').primaryKey().defaultRandom(),
  rideId: uuid('ride_id'),
  riderId: uuid('rider_id').notNull(),
  pickupLat: doublePrecision('pickup_lat').notNull(),
  pickupLng: doublePrecision('pickup_lng').notNull(),
  dropoffLat: doublePrecision('dropoff_lat').notNull(),
  dropoffLng: doublePrecision('dropoff_lng').notNull(),
  pickupCell: varchar('pickup_cell', { length: 32 }).notNull(),
  vehicleType: varchar('vehicle_type', { length: 32 }).notNull().default('SEDAN'),
  baseFareMinorUnits: integer('base_fare_minor_units').notNull(),
  distanceMeters: integer('distance_meters').notNull(),
  durationSec: integer('duration_sec').notNull(),
  surgeMultiplier: doublePrecision('surge_multiplier').notNull(),
  totalFareMinorUnits: integer('total_fare_minor_units').notNull(),
  currency: varchar('currency', { length: 8 }).notNull().default('INR'),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const surgeHistory = pgTable('surge_history', {
  id: uuid('id').primaryKey().defaultRandom(),
  cell: varchar('cell', { length: 32 }).notNull(),
  demand: doublePrecision('demand').notNull(),
  supply: doublePrecision('supply').notNull(),
  multiplier: doublePrecision('multiplier').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const surgeOverrides = pgTable('surge_overrides', {
  id: uuid('id').primaryKey().defaultRandom(),
  cell: varchar('cell', { length: 32 }).notNull(),
  multiplier: doublePrecision('multiplier').notNull(),
  actor: varchar('actor', { length: 64 }).notNull(),
  reason: varchar('reason', { length: 255 }).notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export type Quote = typeof quotes.$inferSelect;
export type NewQuote = typeof quotes.$inferInsert;
export type SurgeHistoryRow = typeof surgeHistory.$inferSelect;
export type SurgeOverrideRow = typeof surgeOverrides.$inferSelect;
