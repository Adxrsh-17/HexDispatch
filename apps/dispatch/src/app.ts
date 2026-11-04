import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { buildServer, AppError } from '@hexdispatch/shared';
import type { OfferManager } from './services/offer-manager';
import type { DispatchEngine } from './services/dispatch-engine';
import { rideRequestedEvent } from '@hexdispatch/contracts';

export interface DispatchAppOptions {
  offerManager: OfferManager;
  dispatchEngine: DispatchEngine;
  logLevel?: string;
}

const acceptOfferSchema = z.object({
  driverId: z.string().uuid().optional(),
});

const declineOfferSchema = z.object({
  driverId: z.string().uuid().optional(),
  reason: z.string().optional(),
});

const tripActionSchema = z.object({
  driverId: z.string().uuid().optional(),
});

export async function buildDispatchApp(options: DispatchAppOptions): Promise<FastifyInstance> {
  const { offerManager, dispatchEngine, logLevel } = options;

  const app = buildServer({
    service: 'dispatch',
    logLevel,
  });

  // GET /offers/:id
  app.get('/offers/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const offer = await offerManager.getOfferById(id);
    if (!offer) {
      throw AppError.notFound(`Offer ${id} not found`);
    }
    return reply.send(offer);
  });

  // POST /offers/:id/accept
  app.post('/offers/:id/accept', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = acceptOfferSchema.parse(request.body ?? {});
    const driverId = (request.headers['x-user-id'] as string) || body.driverId;

    if (!driverId) {
      throw AppError.badRequest('Driver identification required (driverId or x-user-id)');
    }

    const updated = await offerManager.acceptOffer(id, driverId);
    return reply.send(updated);
  });

  // POST /offers/:id/decline
  app.post('/offers/:id/decline', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = declineOfferSchema.parse(request.body ?? {});
    const driverId = (request.headers['x-user-id'] as string) || body.driverId;

    if (!driverId) {
      throw AppError.badRequest('Driver identification required (driverId or x-user-id)');
    }

    const updated = await offerManager.declineOffer(id, driverId, body.reason);
    return reply.send(updated);
  });

  // POST /rides/:id/arrived
  app.post('/rides/:id/arrived', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = tripActionSchema.parse(request.body ?? {});
    const driverId = (request.headers['x-user-id'] as string) || body.driverId;

    if (!driverId) {
      throw AppError.badRequest('Driver identification required');
    }

    await dispatchEngine.driverArrived(id, driverId);
    return reply.send({ status: 'ok', rideId: id, state: 'DRIVER_ARRIVED' });
  });

  // POST /rides/:id/start
  app.post('/rides/:id/start', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = tripActionSchema.parse(request.body ?? {});
    const driverId = (request.headers['x-user-id'] as string) || body.driverId;

    if (!driverId) {
      throw AppError.badRequest('Driver identification required');
    }

    await dispatchEngine.startTrip(id, driverId);
    return reply.send({ status: 'ok', rideId: id, state: 'IN_TRIP' });
  });

  // POST /rides/:id/complete
  app.post('/rides/:id/complete', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = tripActionSchema.parse(request.body ?? {});
    const driverId = (request.headers['x-user-id'] as string) || body.driverId;

    if (!driverId) {
      throw AppError.badRequest('Driver identification required');
    }

    await dispatchEngine.completeTrip(id, driverId);
    return reply.send({ status: 'ok', rideId: id, state: 'COMPLETED' });
  });

  // POST /internal/rides/match (Internal webhook / event trigger)
  app.post('/internal/rides/match', async (request, reply) => {
    const event = rideRequestedEvent.parse(request.body);
    await dispatchEngine.handleRideRequested(event);
    return reply.send({ status: 'processing', rideId: event.payload.rideId });
  });

  return app;
}
