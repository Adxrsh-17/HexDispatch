import type { FastifyInstance } from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import { z } from 'zod';
import { buildServer, AppError } from '@hexdispatch/shared';
import type { DriverIndex } from './driver-index';
import type { NearbySearch } from './nearby';
import type { LocationBatchPublisher } from './batch-publisher';
import type { TrustEngine } from './trust/trust-engine';
import { locationPingSchema, validatePingFreshnessAndSanity } from './validation';
import type Redis from 'ioredis';

export interface LocationAppOptions {
  driverIndex: DriverIndex;
  nearbySearch: NearbySearch;
  batchPublisher: LocationBatchPublisher;
  trustEngine?: TrustEngine;
  redisPubSub?: Redis;
  logLevel?: string;
}

const nearbyQuerySchema = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lng: z.coerce.number().min(-180).max(180),
  radiusKm: z.coerce.number().positive().default(5),
  limit: z.coerce.number().int().min(1).max(100).default(10),
  status: z.enum(['AVAILABLE', 'ON_OFFER', 'ON_TRIP', 'OFFLINE']).default('AVAILABLE'),
});

export async function buildLocationApp(options: LocationAppOptions): Promise<FastifyInstance> {
  const { driverIndex, nearbySearch, batchPublisher, trustEngine, redisPubSub, logLevel } = options;

  const app = buildServer({
    service: 'location',
    logLevel,
  });

  await app.register(fastifyWebsocket);

  // Ingest helper
  async function processLocationPing(driverId: string, body: unknown, correlationId: string) {
    const ping = locationPingSchema.parse(body);
    const previous = await driverIndex.getDriver(driverId);

    validatePingFreshnessAndSanity(ping, previous);

    // Evaluate trust & safety anomaly detection (Task 1)
    if (trustEngine) {
      await trustEngine.evaluateLocationPing(driverId, {
        lat: ping.lat,
        lng: ping.lng,
        status: ping.status,
        timestampMs: new Date(ping.ts).getTime(),
      });
    }

    const driverLoc = {
      driverId,
      lat: ping.lat,
      lng: ping.lng,
      heading: ping.heading,
      speedMps: ping.speedMps,
      status: ping.status,
      ts: ping.ts,
    };

    const { cell, previousCell } = await driverIndex.updateLocation(driverLoc);

    // Queue for Kafka batch publishing
    void batchPublisher.enqueue(driverLoc, correlationId);

    // Publish to Redis Pub/Sub if fan-out client provided
    if (redisPubSub) {
      void redisPubSub.publish(`pubsub:driver:${driverId}`, JSON.stringify(driverLoc));
    }

    return { status: 'ok', cell, previousCell, ts: ping.ts };
  }

  // POST /drivers/me/location
  app.post('/drivers/me/location', async (request, reply) => {
    const driverId = (request.headers['x-user-id'] as string) || '';
    if (!driverId) {
      throw AppError.unauthorized('Driver identification required (x-user-id)');
    }

    const result = await processLocationPing(driverId, request.body, request.id);
    return reply.send(result);
  });

  // GET /drivers/nearby (internal)
  app.get('/drivers/nearby', async (request, reply) => {
    const query = nearbyQuerySchema.parse(request.query);
    const candidates = await nearbySearch.findNearby(query);
    return reply.send(candidates);
  });

  // GET /admin/trust/flags (admin trust audit endpoint)
  app.get('/admin/trust/flags', async (_request, reply) => {
    const flags = trustEngine ? trustEngine.getAllFlags() : [];
    return reply.send({
      count: flags.length,
      flags,
    });
  });

  // POST /admin/trust/ride-outcome (record ride outcome for cancellation abuse detection)
  app.post('/admin/trust/ride-outcome', async (request, reply) => {
    if (!trustEngine) {
      return reply.code(400).send({ error: 'TrustEngine not enabled' });
    }
    const outcomeSchema = z.object({
      subjectId: z.string().uuid(),
      subjectType: z.enum(['DRIVER', 'RIDER']),
      isCancelled: z.boolean(),
      timestampMs: z.number().optional(),
    });
    const parsed = outcomeSchema.parse(request.body);
    const result = await trustEngine.recordRideOutcome(parsed);
    return reply.send(result);
  });

  // WebSocket Location Ingest: /drivers/me/location/ws
  app.get('/drivers/me/location/ws', { websocket: true }, (socket, req) => {
    const driverId =
      (req.headers['x-user-id'] as string) ||
      (new URL(req.url, 'http://localhost').searchParams.get('driverId') ?? '');

    if (!driverId) {
      socket.send(JSON.stringify({ error: 'Missing driver identification' }));
      socket.close();
      return;
    }

    socket.on('message', async (data: Buffer | string) => {
      try {
        const payload = JSON.parse(data.toString());
        const result = await processLocationPing(driverId, payload, req.id);
        socket.send(JSON.stringify({ ack: true, ...result }));
      } catch (err) {
        socket.send(
          JSON.stringify({
            ack: false,
            error: err instanceof Error ? err.message : 'Invalid ping',
          }),
        );
      }
    });
  });

  return app;
}
