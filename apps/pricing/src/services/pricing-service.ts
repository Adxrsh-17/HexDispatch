import { randomUUID } from 'node:crypto';
import { eq, and, gt } from 'drizzle-orm';
import { latLngToCell, gridDisk } from 'h3-js';
import type Redis from 'ioredis';
import { Counter, Gauge, type Registry } from 'prom-client';
import { TOPICS, type SurgeUpdatedEvent } from '@hexdispatch/contracts';
import { AppError, internalFetch } from '@hexdispatch/shared';
import { quotes, surgeHistory, surgeOverrides, type Quote } from '../db/schema';
import { calculateFare, type FareBreakdown } from '../fare';
import { computeSurgeStep, type SurgeConfig, type SurgeExplainOutput } from '../surge-engine';

export interface CreateQuoteParams {
  riderId: string;
  pickup: { lat: number; lng: number };
  dropoff: { lat: number; lng: number };
  vehicleType?: string;
  rideId?: string;
}

export interface PricingServiceOptions {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle db
  db: any;
  redis: Redis;
  quoteTtlSec?: number;
  surgeIntervalSec?: number;
  surgeConfig?: Partial<SurgeConfig>;
  locationUrl?: string;
  redisPubSub?: Redis;
  metricsRegistry?: Registry;
  producer?: {
    publish: (topic: string, key: string, payload: unknown) => Promise<void>;
  };
}

export class PricingService {
  private quoteTtlSec: number;
  private surgeIntervalSec: number;
  private surgeTimer?: NodeJS.Timeout;

  // Track smoothed demand/supply and multipliers in-memory per cell
  private stateCache = new Map<
    string,
    { smoothedDemand: number; smoothedSupply: number; multiplier: number }
  >();

  readonly surgeMultiplierGauge: Gauge<string>;
  readonly surgeChangesCounter: Counter<string>;
  readonly quotesCreatedCounter: Counter<string>;

  constructor(private options: PricingServiceOptions) {
    this.quoteTtlSec = options.quoteTtlSec ?? 300; // 5 minutes default
    this.surgeIntervalSec = options.surgeIntervalSec ?? 30; // 30 seconds default

    const registry = options.metricsRegistry;
    this.surgeMultiplierGauge = new Gauge({
      name: 'surge_multiplier',
      help: 'Current surge multiplier per H3 cell',
      labelNames: ['cell'],
      registers: registry ? [registry] : [],
    });
    this.surgeChangesCounter = new Counter({
      name: 'surge_changes_total',
      help: 'Total number of surge multiplier transitions',
      labelNames: ['cell'],
      registers: registry ? [registry] : [],
    });
    this.quotesCreatedCounter = new Counter({
      name: 'quotes_created_total',
      help: 'Total number of price quotes generated',
      labelNames: ['vehicle_type'],
      registers: registry ? [registry] : [],
    });
  }

  startSurgeLoop(): void {
    if (this.surgeTimer) return;
    this.surgeTimer = setInterval(() => {
      this.runSurgeCycle().catch((err) => {
        console.error('Error during scheduled surge cycle:', err);
      });
    }, this.surgeIntervalSec * 1000);
  }

  stopSurgeLoop(): void {
    if (this.surgeTimer) {
      clearInterval(this.surgeTimer);
      this.surgeTimer = undefined;
    }
  }

  stop(): void {
    this.stopSurgeLoop();
  }

  getCellForPoint(lat: number, lng: number): string {
    return latLngToCell(lat, lng, 8); // H3 res 8 for pricing per PROJECT_PLAN
  }

  // --- Quote Lifecycle ---

  async createQuote(params: CreateQuoteParams): Promise<Quote & { breakdown: FareBreakdown }> {
    const pickupCell = this.getCellForPoint(params.pickup.lat, params.pickup.lng);
    const surgeMultiplier = await this.getSurgeMultiplierForCell(pickupCell);
    const vehicleType = (params.vehicleType ?? 'SEDAN').toUpperCase();

    const breakdown = calculateFare({
      pickup: params.pickup,
      dropoff: params.dropoff,
      vehicleType,
      surgeMultiplier,
    });

    const quoteId = randomUUID();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.quoteTtlSec * 1000);

    const [inserted] = await this.options.db
      .insert(quotes)
      .values({
        id: quoteId,
        rideId: params.rideId ?? null,
        riderId: params.riderId,
        pickupLat: params.pickup.lat,
        pickupLng: params.pickup.lng,
        dropoffLat: params.dropoff.lat,
        dropoffLng: params.dropoff.lng,
        pickupCell,
        vehicleType,
        baseFareMinorUnits: breakdown.baseFareMinorUnits,
        distanceMeters: breakdown.distanceMeters,
        durationSec: breakdown.durationSec,
        surgeMultiplier: breakdown.surgeMultiplier,
        totalFareMinorUnits: breakdown.totalFareMinorUnits,
        currency: 'INR',
        expiresAt,
        createdAt: now,
      })
      .returning();

    this.quotesCreatedCounter.inc({ vehicle_type: vehicleType });

    return {
      ...inserted,
      breakdown,
    };
  }

  async getQuoteById(quoteId: string): Promise<Quote | null> {
    const rows = await this.options.db.select().from(quotes).where(eq(quotes.id, quoteId)).limit(1);

    return rows[0] ?? null;
  }

  async lockRideToQuote(quoteId: string, rideId: string): Promise<Quote> {
    const quote = await this.getQuoteById(quoteId);
    if (!quote) {
      throw AppError.notFound(`Quote ${quoteId} not found`);
    }

    if (new Date() >= new Date(quote.expiresAt)) {
      throw AppError.conflict(`Quote ${quoteId} has expired`);
    }

    const [updated] = await this.options.db
      .update(quotes)
      .set({ rideId })
      .where(eq(quotes.id, quoteId))
      .returning();

    return updated!;
  }

  // --- Demand Tracking in Redis Sliding Windows ---

  async recordDemandEvent(cell: string, timestampMs = Date.now()): Promise<void> {
    const key = `demand:${cell}`;
    // Store in sorted set with timestamp as score
    await this.options.redis.zadd(key, timestampMs, `${randomUUID()}`);
    // Keep window of 15 minutes (900 seconds)
    const cutoff = timestampMs - 15 * 60 * 1000;
    await this.options.redis.zremrangebyscore(key, '-inf', cutoff);
    await this.options.redis.expire(key, 1800);
  }

  async getRecentDemandCount(cell: string, windowMinutes = 5): Promise<number> {
    const key = `demand:${cell}`;
    const now = Date.now();
    const windowStart = now - windowMinutes * 60 * 1000;
    return this.options.redis.zcount(key, windowStart, '+inf');
  }

  // --- Supply Query ---

  async getAvailableSupplyCount(cell: string): Promise<number> {
    // If locationUrl is available, query drivers nearby or in cell
    if (this.options.locationUrl) {
      try {
        const res = await internalFetch(`${this.options.locationUrl}/drivers/cell/${cell}/count`);
        if (res.ok) {
          const data = (await res.json()) as { count: number };
          return data.count;
        }
      } catch {
        // Fall back to Redis cache
      }
    }

    // Default: check Redis key `supply:${cell}`
    const cached = await this.options.redis.get(`supply:${cell}`);
    return cached ? Number.parseInt(cached, 10) : 5; // default reasonable estimate if not populated
  }

  async setAvailableSupplyCount(cell: string, count: number): Promise<void> {
    await this.options.redis.set(`supply:${cell}`, count.toString(), 'EX', 3600);
  }

  // --- Surge Query & Multipliers ---

  async getSurgeMultiplierForCell(cell: string): Promise<number> {
    // 1. Check active admin override
    const override = await this.getActiveOverride(cell);
    if (override) {
      return override.multiplier;
    }

    // 2. Check Redis cache
    const cached = await this.options.redis.get(`surge:${cell}`);
    if (cached) {
      return Number.parseFloat(cached);
    }

    // 3. Fallback default 1.0
    return 1.0;
  }

  async getActiveOverride(cell: string) {
    const now = new Date();
    const rows = await this.options.db
      .select()
      .from(surgeOverrides)
      .where(and(eq(surgeOverrides.cell, cell), gt(surgeOverrides.expiresAt, now)))
      .limit(1);

    return rows[0] ?? null;
  }

  async explainSurge(cell: string): Promise<SurgeExplainOutput> {
    const demand = await this.getRecentDemandCount(cell);
    const supply = await this.getAvailableSupplyCount(cell);
    const cached = this.stateCache.get(cell);
    const prevM = cached?.multiplier ?? (await this.getSurgeMultiplierForCell(cell));

    // Ring-1 neighbour multipliers
    const neighbourCells = gridDisk(cell, 1).filter((c) => c !== cell);
    const neighbourMultipliers: number[] = [];
    for (const nCell of neighbourCells) {
      neighbourMultipliers.push(await this.getSurgeMultiplierForCell(nCell));
    }

    const override = await this.getActiveOverride(cell);

    return computeSurgeStep({
      cell,
      demand,
      supply,
      prevSmoothedDemand: cached?.smoothedDemand,
      prevSmoothedSupply: cached?.smoothedSupply,
      prevMultiplier: prevM,
      neighbourMultipliers,
      adminOverride: override ? override.multiplier : undefined,
      config: this.options.surgeConfig,
    });
  }

  async setAdminOverride(params: {
    cell: string;
    multiplier: number;
    expiresAt: Date;
    actor: string;
    reason: string;
  }): Promise<void> {
    // Delete any existing override for cell
    await this.options.db.delete(surgeOverrides).where(eq(surgeOverrides.cell, params.cell));

    // Insert new override row
    await this.options.db.insert(surgeOverrides).values({
      id: randomUUID(),
      cell: params.cell,
      multiplier: params.multiplier,
      actor: params.actor,
      reason: params.reason,
      expiresAt: params.expiresAt,
      createdAt: new Date(),
    });

    // Update Redis cache
    await this.options.redis.set(
      `surge:${params.cell}`,
      params.multiplier.toFixed(2),
      'EX',
      Math.max(10, Math.round((params.expiresAt.getTime() - Date.now()) / 1000)),
    );

    this.surgeMultiplierGauge.set({ cell: params.cell }, params.multiplier);

    // Publish event
    await this.publishSurgeUpdated({
      cell: params.cell,
      multiplier: params.multiplier,
      demand: 0,
      supply: 0,
    });
  }

  async clearAdminOverride(cell: string): Promise<void> {
    await this.options.db.delete(surgeOverrides).where(eq(surgeOverrides.cell, cell));

    await this.options.redis.del(`surge:${cell}`);
    this.surgeMultiplierGauge.set({ cell }, 1.0);
  }

  // --- Surge Cycle ---

  async runSurgeCycle(cellsToProcess?: string[]): Promise<Map<string, SurgeExplainOutput>> {
    let cells = cellsToProcess;
    if (!cells || cells.length === 0) {
      // Find all cells with demand or cached state
      const keys = await this.options.redis.keys('demand:*');
      const demandCells = keys.map((k) => k.replace('demand:', ''));
      const cachedCells = Array.from(this.stateCache.keys());
      cells = Array.from(new Set([...demandCells, ...cachedCells]));
    }

    const results = new Map<string, SurgeExplainOutput>();

    for (const cell of cells) {
      const explain = await this.explainSurge(cell);
      results.set(cell, explain);

      // Update state cache
      this.stateCache.set(cell, {
        smoothedDemand: explain.smoothedDemand,
        smoothedSupply: explain.smoothedSupply,
        multiplier: explain.finalMultiplier,
      });

      const prevMultiplier = await this.getSurgeMultiplierForCell(cell);
      const changed = Math.abs(explain.finalMultiplier - prevMultiplier) >= 0.01;

      // Update Redis cache
      await this.options.redis.set(
        `surge:${cell}`,
        explain.finalMultiplier.toFixed(2),
        'EX',
        this.surgeIntervalSec * 4,
      );

      this.surgeMultiplierGauge.set({ cell }, explain.finalMultiplier);

      if (changed) {
        this.surgeChangesCounter.inc({ cell });

        // Record history row
        await this.options.db.insert(surgeHistory).values({
          id: randomUUID(),
          cell,
          demand: explain.smoothedDemand,
          supply: explain.smoothedSupply,
          multiplier: explain.finalMultiplier,
          createdAt: new Date(),
        });

        // Publish event
        await this.publishSurgeUpdated({
          cell,
          multiplier: explain.finalMultiplier,
          demand: explain.smoothedDemand,
          supply: explain.smoothedSupply,
        });
      }
    }

    return results;
  }

  private async publishSurgeUpdated(params: {
    cell: string;
    multiplier: number;
    demand: number;
    supply: number;
  }): Promise<void> {
    const now = new Date();
    const event: SurgeUpdatedEvent = {
      eventId: randomUUID(),
      type: TOPICS.PRICING_SURGE_UPDATED,
      version: 1,
      occurredAt: now.toISOString(),
      correlationId: params.cell,
      payload: {
        cell: params.cell,
        multiplier: params.multiplier,
        demand: params.demand,
        supply: params.supply,
        ts: now.toISOString(),
      },
    };

    if (this.options.producer) {
      await this.options.producer.publish(TOPICS.PRICING_SURGE_UPDATED, params.cell, event);
    }

    if (this.options.redisPubSub) {
      await this.options.redisPubSub.publish(
        `cell:${params.cell}`,
        JSON.stringify({
          type: 'SURGE_UPDATED',
          payload: event.payload,
        }),
      );
    }
  }
}
