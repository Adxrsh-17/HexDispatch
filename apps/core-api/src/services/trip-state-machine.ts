import { randomUUID } from 'node:crypto';
import { eq, and } from 'drizzle-orm';
import { Counter, type Registry } from 'prom-client';
import {
  type TripActor,
  type TripState,
  type TripTransition,
  TripState as TS,
  TERMINAL_TRIP_STATES,
  TOPICS,
  type TripStateChangedEvent,
} from '@hexdispatch/contracts';
import { AppError } from '@hexdispatch/shared';
import { rides, rideEvents, outbox, type Ride } from '../db/schema';

export const TRIP_TRANSITIONS: readonly TripTransition[] = [
  // REQUESTED
  { from: TS.REQUESTED, to: TS.MATCHING, actors: ['SYSTEM'] },
  { from: TS.REQUESTED, to: TS.CANCELLED_BY_RIDER, actors: ['RIDER'] },
  { from: TS.REQUESTED, to: TS.FAILED, actors: ['SYSTEM', 'ADMIN'] },

  // MATCHING
  { from: TS.MATCHING, to: TS.OFFERED, actors: ['SYSTEM'] },
  { from: TS.MATCHING, to: TS.NO_DRIVER_FOUND, actors: ['SYSTEM'] },
  { from: TS.MATCHING, to: TS.CANCELLED_BY_RIDER, actors: ['RIDER'] },
  { from: TS.MATCHING, to: TS.FAILED, actors: ['SYSTEM', 'ADMIN'] },

  // OFFERED
  { from: TS.OFFERED, to: TS.ASSIGNED, actors: ['DRIVER'] },
  { from: TS.OFFERED, to: TS.MATCHING, actors: ['SYSTEM'] },
  { from: TS.OFFERED, to: TS.CANCELLED_BY_RIDER, actors: ['RIDER'] },
  { from: TS.OFFERED, to: TS.FAILED, actors: ['SYSTEM', 'ADMIN'] },

  // ASSIGNED
  { from: TS.ASSIGNED, to: TS.DRIVER_ARRIVED, actors: ['DRIVER'] },
  { from: TS.ASSIGNED, to: TS.CANCELLED_BY_RIDER, actors: ['RIDER'] },
  { from: TS.ASSIGNED, to: TS.CANCELLED_BY_DRIVER, actors: ['DRIVER'] },
  { from: TS.ASSIGNED, to: TS.MATCHING, actors: ['SYSTEM'] },
  { from: TS.ASSIGNED, to: TS.FAILED, actors: ['SYSTEM', 'ADMIN'] },

  // DRIVER_ARRIVED
  { from: TS.DRIVER_ARRIVED, to: TS.IN_PROGRESS, actors: ['DRIVER'] },
  { from: TS.DRIVER_ARRIVED, to: TS.CANCELLED_BY_RIDER, actors: ['RIDER'] },
  { from: TS.DRIVER_ARRIVED, to: TS.CANCELLED_BY_DRIVER, actors: ['DRIVER'] },
  { from: TS.DRIVER_ARRIVED, to: TS.FAILED, actors: ['SYSTEM', 'ADMIN'] },

  // IN_PROGRESS
  { from: TS.IN_PROGRESS, to: TS.COMPLETED, actors: ['DRIVER'] },
  { from: TS.IN_PROGRESS, to: TS.FAILED, actors: ['SYSTEM', 'ADMIN'] },
];

let rideTransitionsTotal: Counter<string> | null = null;

export function getRideTransitionsMetric(registry?: Registry): Counter<string> {
  if (!rideTransitionsTotal) {
    rideTransitionsTotal = new Counter({
      name: 'ride_transitions_total',
      help: 'Total count of ride state transitions',
      labelNames: ['from', 'to'] as const,
      registers: registry ? [registry] : undefined,
    });
  }
  return rideTransitionsTotal;
}

export function isTransitionLegal(from: TripState, to: TripState, actor: TripActor): boolean {
  if ((TERMINAL_TRIP_STATES as readonly string[]).includes(from)) {
    return false;
  }
  return TRIP_TRANSITIONS.some(
    (rule) => rule.from === from && rule.to === to && rule.actors.includes(actor),
  );
}

export interface TransitionOptions {
  driverId?: string | null;
  correlationId?: string;
}

export async function transitionRide(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle transaction type flexibility
  tx: any,
  rideId: string,
  toState: TripState,
  actor: TripActor,
  expectedVersion?: number,
  options: TransitionOptions = {},
): Promise<Ride> {
  const currentRides = await tx.select().from(rides).where(eq(rides.id, rideId)).limit(1);
  if (currentRides.length === 0) {
    throw AppError.notFound(`Ride ${rideId} not found`);
  }
  const current = currentRides[0];

  if (expectedVersion !== undefined && current.version !== expectedVersion) {
    throw AppError.conflict(
      `Optimistic lock failure: ride version is ${current.version}, expected ${expectedVersion}`,
    );
  }

  if (!isTransitionLegal(current.status, toState, actor)) {
    throw AppError.badRequest(
      `Illegal transition from ${current.status} to ${toState} by actor ${actor}`,
    );
  }

  const nextVersion = current.version + 1;
  const now = new Date();

  const updateData: Partial<typeof rides.$inferInsert> = {
    status: toState,
    version: nextVersion,
    updatedAt: now,
  };
  if (options.driverId !== undefined) {
    updateData.driverId = options.driverId;
  }

  const updatedRows = await tx
    .update(rides)
    .set(updateData)
    .where(and(eq(rides.id, rideId), eq(rides.version, current.version)))
    .returning();

  if (updatedRows.length === 0) {
    throw AppError.conflict(`Concurrent modification detected when updating ride ${rideId}`);
  }

  const updatedRide = updatedRows[0];

  // Audit event row
  await tx.insert(rideEvents).values({
    rideId,
    fromState: current.status,
    toState,
    actor,
    version: nextVersion,
    createdAt: now,
  });

  // Outbox event row
  const eventPayload: TripStateChangedEvent = {
    eventId: randomUUID(),
    type: TOPICS.TRIP_STATE_CHANGED,
    version: 1,
    occurredAt: now.toISOString(),
    correlationId: options.correlationId ?? randomUUID(),
    payload: {
      rideId,
      from: current.status,
      to: toState,
      version: nextVersion,
      actor,
    },
  };

  await tx.insert(outbox).values({
    aggregateId: rideId,
    topic: TOPICS.TRIP_STATE_CHANGED,
    key: rideId,
    payload: eventPayload,
    createdAt: now,
  });

  getRideTransitionsMetric().labels(current.status, toState).inc();

  return updatedRide;
}
