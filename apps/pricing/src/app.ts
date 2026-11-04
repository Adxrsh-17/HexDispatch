import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { buildServer, AppError } from '@hexdispatch/shared';
import type { PricingService } from './services/pricing-service';

export interface PricingAppOptions {
  pricingService: PricingService;
  logLevel?: string;
}

const latLngSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});

const createQuoteSchema = z.object({
  riderId: z.string().uuid().optional(),
  pickup: latLngSchema,
  dropoff: latLngSchema,
  vehicleType: z.string().optional(),
  rideId: z.string().uuid().optional(),
});

const adminSurgeOverrideSchema = z.object({
  multiplier: z.number().min(1.0).max(5.0),
  expiresAt: z.string().datetime(),
  actor: z.string().optional(),
  reason: z.string().min(1),
});

export async function buildPricingApp(options: PricingAppOptions): Promise<FastifyInstance> {
  const { pricingService, logLevel } = options;

  const app = buildServer({
    service: 'pricing',
    logLevel,
  });

  // POST /quotes: Request fare quote with current surge
  app.post('/quotes', async (request, reply) => {
    const body = createQuoteSchema.parse(request.body);
    const riderId = (request.headers['x-user-id'] as string) || body.riderId;

    if (!riderId) {
      throw AppError.badRequest('Rider identification required (riderId or x-user-id)');
    }

    const quote = await pricingService.createQuote({
      riderId,
      pickup: body.pickup,
      dropoff: body.dropoff,
      vehicleType: body.vehicleType,
      rideId: body.rideId,
    });

    return reply.status(201).send(quote);
  });

  // GET /quotes/:id: Retrieve locked quote
  app.get('/quotes/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const quote = await pricingService.getQuoteById(id);
    if (!quote) {
      throw AppError.notFound(`Quote ${id} not found`);
    }

    const isExpired = new Date() >= new Date(quote.expiresAt);
    return reply.send({
      ...quote,
      isExpired,
    });
  });

  // POST /quotes/:id/lock: Lock a quote to a ride
  app.post('/quotes/:id/lock', async (request, reply) => {
    const { id } = request.params as { id: string };
    const { rideId } = (request.body as { rideId: string }) ?? {};
    if (!rideId) {
      throw AppError.badRequest('rideId is required to lock quote');
    }

    const updated = await pricingService.lockRideToQuote(id, rideId);
    return reply.send(updated);
  });

  // GET /surge: Query surge by coordinates
  app.get('/surge', async (request, reply) => {
    const query = request.query as { lat?: string; lng?: string };
    if (!query.lat || !query.lng) {
      throw AppError.badRequest('lat and lng query parameters are required');
    }

    const lat = Number.parseFloat(query.lat);
    const lng = Number.parseFloat(query.lng);
    const cell = pricingService.getCellForPoint(lat, lng);
    const multiplier = await pricingService.getSurgeMultiplierForCell(cell);
    const override = await pricingService.getActiveOverride(cell);

    return reply.send({
      cell,
      multiplier,
      hasAdminOverride: Boolean(override),
    });
  });

  // GET /surge/:cell/explain: Explain surge calculation (Task 6 & AC4)
  app.get('/surge/:cell/explain', async (request, reply) => {
    const { cell } = request.params as { cell: string };
    const explanation = await pricingService.explainSurge(cell);
    return reply.send(explanation);
  });

  // PUT /admin/surge/:cell: Set admin surge override (Task 6)
  app.put('/admin/surge/:cell', async (request, reply) => {
    const { cell } = request.params as { cell: string };
    const body = adminSurgeOverrideSchema.parse(request.body);
    const actor = (request.headers['x-user-id'] as string) || body.actor || 'admin';

    await pricingService.setAdminOverride({
      cell,
      multiplier: body.multiplier,
      expiresAt: new Date(body.expiresAt),
      actor,
      reason: body.reason,
    });

    return reply.send({
      status: 'ok',
      cell,
      multiplier: body.multiplier,
      expiresAt: body.expiresAt,
    });
  });

  // DELETE /admin/surge/:cell: Clear admin surge override
  app.delete('/admin/surge/:cell', async (request, reply) => {
    const { cell } = request.params as { cell: string };
    await pricingService.clearAdminOverride(cell);
    return reply.send({ status: 'ok', cell, multiplier: 1.0 });
  });

  // POST /internal/surge/cycle: Trigger surge cycle on-demand
  app.post('/internal/surge/cycle', async (request, reply) => {
    const body = (request.body as { cells?: string[] }) ?? {};
    const results = await pricingService.runSurgeCycle(body.cells);
    const output: Record<string, unknown> = {};
    for (const [cell, explain] of results.entries()) {
      output[cell] = explain;
    }
    return reply.send({
      status: 'ok',
      processedCells: Object.keys(output).length,
      results: output,
    });
  });

  return app;
}
