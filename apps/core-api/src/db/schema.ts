import {
  pgTable,
  uuid,
  text,
  boolean,
  integer,
  doublePrecision,
  numeric,
  timestamp,
  jsonb,
} from 'drizzle-orm/pg-core';
import type { TripActor, TripState } from '@hexdispatch/contracts';

export const users = pgTable('users', {
  id: uuid('id').defaultRandom().primaryKey(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  role: text('role').$type<'RIDER' | 'DRIVER' | 'ADMIN'>().notNull(),
  status: text('status').default('ACTIVE').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const drivers = pgTable('drivers', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  vehicleType: text('vehicle_type').notNull(),
  plate: text('plate').notNull(),
  rating: numeric('rating', { precision: 3, scale: 2 }).default('5.0').notNull(),
  online: boolean('online').default(false).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const rides = pgTable('rides', {
  id: uuid('id').defaultRandom().primaryKey(),
  riderId: uuid('rider_id')
    .notNull()
    .references(() => users.id),
  driverId: uuid('driver_id').references(() => users.id),
  pickupLat: doublePrecision('pickup_lat').notNull(),
  pickupLng: doublePrecision('pickup_lng').notNull(),
  dropoffLat: doublePrecision('dropoff_lat').notNull(),
  dropoffLng: doublePrecision('dropoff_lng').notNull(),
  pickupCell: text('pickup_cell').notNull(),
  status: text('status').$type<TripState>().default('REQUESTED').notNull(),
  version: integer('version').default(0).notNull(),
  quoteId: uuid('quote_id'),
  fareEstimate: integer('fare_estimate').notNull(),
  fareFinal: integer('fare_final'),
  idempotencyKey: text('idempotency_key'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export const rideEvents = pgTable('ride_events', {
  id: uuid('id').defaultRandom().primaryKey(),
  rideId: uuid('ride_id')
    .notNull()
    .references(() => rides.id, { onDelete: 'cascade' }),
  fromState: text('from_state').$type<TripState | null>(),
  toState: text('to_state').$type<TripState>().notNull(),
  actor: text('actor').$type<TripActor>().notNull(),
  version: integer('version').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const outbox = pgTable('outbox', {
  id: uuid('id').defaultRandom().primaryKey(),
  aggregateId: text('aggregate_id').notNull(),
  topic: text('topic').notNull(),
  key: text('key').notNull(),
  payload: jsonb('payload').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  publishedAt: timestamp('published_at', { withTimezone: true }),
});

export const idempotencyKeys = pgTable('idempotency_keys', {
  key: text('key').primaryKey(),
  userId: uuid('user_id').notNull(),
  requestHash: text('request_hash').notNull(),
  responseCode: integer('response_code').notNull(),
  responseBody: jsonb('response_body').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Driver = typeof drivers.$inferSelect;
export type NewDriver = typeof drivers.$inferInsert;
export type Ride = typeof rides.$inferSelect;
export type NewRide = typeof rides.$inferInsert;
export type RideEvent = typeof rideEvents.$inferSelect;
export type OutboxMessage = typeof outbox.$inferSelect;
export type IdempotencyRecord = typeof idempotencyKeys.$inferSelect;
