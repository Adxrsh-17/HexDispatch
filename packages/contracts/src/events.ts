import { z } from 'zod';
import { TOPICS } from './topics';
import { TRIP_STATES } from './trip';

/** Envelope on every Kafka message. `eventId` is the idempotency key for consumers. */
export const eventEnvelope = <T extends z.ZodTypeAny>(type: string, payload: T) =>
  z.object({
    eventId: z.string().uuid(),
    type: z.literal(type),
    version: z.literal(1),
    occurredAt: z.string().datetime(),
    correlationId: z.string().min(1),
    payload,
  });

export const latLngSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});

export const rideRequestedPayload = z.object({
  rideId: z.string().uuid(),
  riderId: z.string().uuid(),
  pickup: latLngSchema,
  dropoff: latLngSchema,
  pickupCell: z.string().min(1),
  vehicleType: z.string().min(1),
  requestedAt: z.string().datetime(),
});

export const tripStateChangedPayload = z.object({
  rideId: z.string().uuid(),
  from: z.enum(TRIP_STATES).nullable(),
  to: z.enum(TRIP_STATES),
  /** Ride row version after the change; consumers use it to drop stale/duplicate events. */
  version: z.number().int().nonnegative(),
  actor: z.enum(['RIDER', 'DRIVER', 'SYSTEM', 'ADMIN']),
});

export const locationUpdatedPayload = z.object({
  driverId: z.string().uuid(),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  heading: z.number().min(0).max(360).optional(),
  speedMps: z.number().min(0).optional(),
  status: z.enum(['AVAILABLE', 'ON_OFFER', 'ON_TRIP', 'OFFLINE']),
  ts: z.string().datetime(),
});

export const surgeUpdatedPayload = z.object({
  cell: z.string().min(1),
  multiplier: z.number().min(1),
  demand: z.number().nonnegative(),
  supply: z.number().nonnegative(),
  ts: z.string().datetime(),
});

export const offerSentPayload = z.object({
  offerId: z.string().uuid(),
  rideId: z.string().uuid(),
  driverId: z.string().uuid(),
  expiresAt: z.string().datetime(),
  pickup: latLngSchema,
  dropoff: latLngSchema,
  pickupEtaSec: z.number().nonnegative(),
});

export const offerDeclinedPayload = z.object({
  offerId: z.string().uuid(),
  rideId: z.string().uuid(),
  driverId: z.string().uuid(),
  reason: z.string().optional(),
});

export const offerExpiredPayload = z.object({
  offerId: z.string().uuid(),
  rideId: z.string().uuid(),
  driverId: z.string().uuid(),
});

export const rideMatchedPayload = z.object({
  rideId: z.string().uuid(),
  driverId: z.string().uuid(),
  policy: z.string().min(1),
  cost: z.number().nonnegative(),
  batchId: z.string().uuid().nullable().optional(),
});

export const rideRequestedEvent = eventEnvelope(TOPICS.RIDE_REQUESTED, rideRequestedPayload);
export const tripStateChangedEvent = eventEnvelope(
  TOPICS.TRIP_STATE_CHANGED,
  tripStateChangedPayload,
);
export const locationUpdatedEvent = eventEnvelope(TOPICS.LOCATION_UPDATED, locationUpdatedPayload);
export const surgeUpdatedEvent = eventEnvelope(TOPICS.PRICING_SURGE_UPDATED, surgeUpdatedPayload);
export const offerSentEvent = eventEnvelope(TOPICS.OFFER_SENT, offerSentPayload);
export const offerDeclinedEvent = eventEnvelope(TOPICS.OFFER_DECLINED, offerDeclinedPayload);
export const offerExpiredEvent = eventEnvelope(TOPICS.OFFER_EXPIRED, offerExpiredPayload);
export const rideMatchedEvent = eventEnvelope(TOPICS.RIDE_MATCHED, rideMatchedPayload);

export type RideRequestedEvent = z.infer<typeof rideRequestedEvent>;
export type TripStateChangedEvent = z.infer<typeof tripStateChangedEvent>;
export type LocationUpdatedEvent = z.infer<typeof locationUpdatedEvent>;
export type SurgeUpdatedEvent = z.infer<typeof surgeUpdatedEvent>;
export type OfferSentEvent = z.infer<typeof offerSentEvent>;
export type OfferDeclinedEvent = z.infer<typeof offerDeclinedEvent>;
export type OfferExpiredEvent = z.infer<typeof offerExpiredEvent>;
export type RideMatchedEvent = z.infer<typeof rideMatchedEvent>;
