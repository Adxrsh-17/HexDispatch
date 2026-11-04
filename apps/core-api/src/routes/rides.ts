import { randomUUID } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { eq, desc } from 'drizzle-orm';
import { latLngToCell } from 'h3-js';
import {
  TOPICS,
  type RideRequestedEvent,
  TRIP_STATES,
  type TripState,
  type TripActor,
} from '@hexdispatch/contracts';
import { AppError } from '@hexdispatch/shared';
import { rides, rideEvents, outbox, type Ride } from '../db/schema';
import { transitionRide } from '../services/trip-state-machine';
import { IdempotencyService } from '../services/idempotency';

const latLngSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});

const createRideSchema = z.object({
  pickup: latLngSchema,
  dropoff: latLngSchema,
  vehicleType: z.string().min(1).default('sedan'),
  quoteId: z.string().uuid().optional(),
});

const transitionSchema = z.object({
  to: z.enum(TRIP_STATES),
  expectedVersion: z.number().int().nonnegative().optional(),
  driverId: z.string().uuid().optional(),
  actor: z.enum(['RIDER', 'DRIVER', 'SYSTEM', 'ADMIN']).optional(),
});

/** Approximate straight-line distance in km */
function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/** Stub fare estimation: base $5.00 (500 cents) + $1.50 (150 cents) per km */
function calculateStubFare(
  pickup: { lat: number; lng: number },
  dropoff: { lat: number; lng: number },
): number {
  const distKm = haversineKm(pickup.lat, pickup.lng, dropoff.lat, dropoff.lng);
  const base = 500;
  const distanceCost = Math.round(distKm * 150);
  return base + distanceCost;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle database instance
export const rideRoutes: FastifyPluginAsync<{ db: any }> = async (app, { db }) => {
  const idempotency = new IdempotencyService(db);

  // POST /rides
  app.post(
    '/rides',
    {
      schema: {
        summary: 'Request a new ride',
        tags: ['Rides'],
        body: createRideSchema,
        headers: z
          .object({
            'idempotency-key': z.string().optional(),
          })
          .passthrough(),
      },
    },
    async (request, reply) => {
      const riderId = (request.headers['x-user-id'] as string) || randomUUID();
      const rawKey = request.headers['idempotency-key'];
      const idempotencyKey =
        typeof rawKey === 'string' && rawKey.trim().length > 0 ? rawKey.trim() : null;

      const body = createRideSchema.parse(request.body);

      // Check idempotency cache first
      if (idempotencyKey) {
        const stored = await idempotency.getStored(idempotencyKey, body);
        if (stored) {
          return reply.code(stored.code).send(stored.body);
        }
      }

      // H3 cell at resolution 8
      const pickupCell = latLngToCell(body.pickup.lat, body.pickup.lng, 8);
      const fareEstimate = calculateStubFare(body.pickup, body.dropoff);
      const now = new Date();

      let createdRide: Ride;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle transaction type
      await db.transaction(async (tx: any) => {
        const [newRide] = await tx
          .insert(rides)
          .values({
            riderId,
            pickupLat: body.pickup.lat,
            pickupLng: body.pickup.lng,
            dropoffLat: body.dropoff.lat,
            dropoffLng: body.dropoff.lng,
            pickupCell,
            status: 'REQUESTED',
            version: 0,
            quoteId: body.quoteId,
            fareEstimate,
            idempotencyKey,
            createdAt: now,
            updatedAt: now,
          })
          .returning();

        createdRide = newRide;

        // Insert initial ride event
        await tx.insert(rideEvents).values({
          rideId: createdRide.id,
          fromState: null,
          toState: 'REQUESTED',
          actor: 'RIDER',
          version: 0,
          createdAt: now,
        });

        // Insert outbox message for Kafka ride.requested
        const eventPayload: RideRequestedEvent = {
          eventId: randomUUID(),
          type: TOPICS.RIDE_REQUESTED,
          version: 1,
          occurredAt: now.toISOString(),
          correlationId: request.id,
          payload: {
            rideId: createdRide.id,
            riderId,
            pickup: body.pickup,
            dropoff: body.dropoff,
            pickupCell,
            vehicleType: body.vehicleType,
            requestedAt: now.toISOString(),
          },
        };

        await tx.insert(outbox).values({
          aggregateId: createdRide.id,
          topic: TOPICS.RIDE_REQUESTED,
          key: pickupCell,
          payload: eventPayload,
          createdAt: now,
        });

        if (idempotencyKey) {
          await idempotency.store(tx, idempotencyKey, riderId, body, 201, createdRide);
        }
      });

      return reply.code(201).send(createdRide!);
    },
  );

  // GET /rides/:id
  app.get(
    '/rides/:id',
    {
      schema: {
        summary: 'Get ride by id',
        tags: ['Rides'],
        params: z.object({ id: z.string().uuid() }),
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const rideRows = await db.select().from(rides).where(eq(rides.id, id)).limit(1);

      if (rideRows.length === 0) {
        throw AppError.notFound(`Ride ${id} not found`);
      }

      return reply.send(rideRows[0]);
    },
  );

  // GET /rides
  app.get(
    '/rides',
    {
      schema: {
        summary: 'List rides',
        tags: ['Rides'],
        querystring: z.object({
          status: z.enum(TRIP_STATES).optional(),
          limit: z.coerce.number().int().min(1).max(100).default(50),
        }),
      },
    },
    async (request, reply) => {
      const { status, limit } = request.query as { status?: TripState; limit: number };
      let query = db.select().from(rides).orderBy(desc(rides.createdAt)).limit(limit);

      if (status) {
        query = query.where(eq(rides.status, status));
      }

      const results = await query;
      return reply.send(results);
    },
  );

  // POST /rides/:id/cancel
  app.post(
    '/rides/:id/cancel',
    {
      schema: {
        summary: 'Cancel ride as rider',
        tags: ['Rides'],
        params: z.object({ id: z.string().uuid() }),
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const actor: TripActor =
        (request.headers['x-user-role'] as string) === 'ADMIN' ? 'ADMIN' : 'RIDER';

      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle transaction type
      const updated = await db.transaction(async (tx: any) => {
        return transitionRide(tx, id, 'CANCELLED_BY_RIDER', actor, undefined, {
          correlationId: request.id,
        });
      });

      return reply.send(updated);
    },
  );

  // POST /rides/:id/transition (Internal / authorized state transition)
  app.post(
    '/rides/:id/transition',
    {
      schema: {
        summary: 'Execute a trip state machine transition',
        tags: ['Rides'],
        params: z.object({ id: z.string().uuid() }),
        body: transitionSchema,
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = transitionSchema.parse(request.body);
      const actor: TripActor =
        body.actor ?? ((request.headers['x-user-role'] as TripActor) || 'SYSTEM');

      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle transaction type
      const updated = await db.transaction(async (tx: any) => {
        return transitionRide(tx, id, body.to, actor, body.expectedVersion, {
          driverId: body.driverId,
          correlationId: request.id,
        });
      });

      return reply.send(updated);
    },
  );
};
