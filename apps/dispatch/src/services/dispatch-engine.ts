import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { latLngToCell } from 'h3-js';
import { Counter, Histogram, type Registry } from 'prom-client';
import {
  TOPICS,
  type RideRequestedEvent,
  type DispatchBatchCompletedEvent,
} from '@hexdispatch/contracts';
import {
  type DriverCandidate,
  type RideRequest,
  type MatchContext,
  type MatchResult,
  type MatchingPolicy,
  GreedyPolicy,
  DEFAULT_MATCHING_CONFIG,
} from '@hexdispatch/matching';
import { AppError, createLogger, internalFetch } from '@hexdispatch/shared';
import { processedEvents, offers } from '../db/schema';
import type { OfferManager } from './offer-manager';
import type { MatchingRegistry } from './matching-registry';
import type { DriverClaimService } from './driver-claim';
import { RideStateError, requestTransition } from './core-client';
import type Redis from 'ioredis';

const logger = createLogger({ service: 'dispatch-engine' });

export interface DispatchEngineOptions {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle db
  db: any;
  offerManager: OfferManager;
  matchingRegistry: MatchingRegistry;
  claimService: DriverClaimService;
  coreApiUrl?: string;
  locationUrl?: string;
  gatewayBroadcastUrl?: string;
  redisPubSub?: Redis;
  matchingPolicy?: string;
  maxOfferAttempts?: number;
  batchWindowMs?: number;
  batchLagFallbackMs?: number;
  /** A batched ride that finds no driver within this time becomes NO_DRIVER_FOUND. Default 60 s. */
  matchingTimeoutMs?: number;
  /** If one solve takes longer than this, later windows use greedy for a cooldown. Default 1500 ms. */
  batchSolveBudgetMs?: number;
  /** How long to stay on greedy after a slow or failed solve. Default 10 s. */
  degradeCooldownMs?: number;
  h3MatcherOwnerRes?: number;
  metricsRegistry?: Registry;
  producer?: {
    publish: (topic: string, key: string, payload: unknown) => Promise<void>;
  };
}

export interface ActiveRideState {
  rideId: string;
  riderId: string;
  pickup: { lat: number; lng: number };
  dropoff: { lat: number; lng: number };
  vehicleType: string;
  requestedAtMs: number;
  attempts: number;
  excludedDriverIds: Set<string>;
}

/** Subset of the core-api ride row that dispatch needs to rebuild its in-memory state. */
interface CoreRideRow {
  id: string;
  riderId: string;
  status: string;
  pickupLat: number;
  pickupLng: number;
  dropoffLat: number;
  dropoffLng: number;
  createdAt: string;
}

const DISPATCHABLE_STATUSES = new Set(['REQUESTED', 'MATCHING', 'OFFERED']);

export class DispatchEngine {
  private activeRides = new Map<string, ActiveRideState>();
  private regionPendingRides = new Map<string, Set<string>>();
  private policyName: string;
  private maxAttempts: number;
  private batchWindowMs: number;
  private batchLagFallbackMs: number;
  private matchingTimeoutMs: number;
  private batchSolveBudgetMs: number;
  private degradeCooldownMs: number;
  private h3MatcherOwnerRes: number;
  private batchTimer?: NodeJS.Timeout;
  private lastBatchRunMs = Date.now();
  private forceFallback = false;
  private degradedUntilMs = 0;
  /** Batch cycles run strictly one at a time; overlapping cycles would double-offer a ride. */
  private cycleChain: Promise<unknown> = Promise.resolve();
  private cycleInFlight = false;

  readonly fallbackCounter: Counter<string>;
  readonly batchErrorCounter: Counter<string>;
  readonly skippedWindowCounter: Counter<string>;
  readonly batchDurationHistogram: Histogram<string>;

  constructor(private options: DispatchEngineOptions) {
    this.policyName = options.matchingPolicy ?? 'greedy';
    this.maxAttempts = options.maxOfferAttempts ?? 3;
    this.batchWindowMs = options.batchWindowMs ?? 2000;
    this.batchLagFallbackMs = options.batchLagFallbackMs ?? 5000;
    this.matchingTimeoutMs = options.matchingTimeoutMs ?? 60_000;
    this.batchSolveBudgetMs = options.batchSolveBudgetMs ?? 1500;
    this.degradeCooldownMs = options.degradeCooldownMs ?? 10_000;
    this.h3MatcherOwnerRes = options.h3MatcherOwnerRes ?? 6;

    const registry = options.metricsRegistry;
    const registers = registry ? [registry] : [];
    this.fallbackCounter = new Counter({
      name: 'dispatch_fallback_total',
      help: 'Total number of batch matching fallbacks to greedy',
      registers,
    });
    this.batchErrorCounter = new Counter({
      name: 'dispatch_batch_errors_total',
      help: 'Batch solves that threw and were replaced by greedy',
      registers,
    });
    this.skippedWindowCounter = new Counter({
      name: 'dispatch_batch_skipped_windows_total',
      help: 'Timer ticks skipped because the previous batch cycle was still running',
      registers,
    });
    this.batchDurationHistogram = new Histogram({
      name: 'dispatch_batch_duration_seconds',
      help: 'Duration of batch matching cycles in seconds',
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
      registers,
    });

    if (this.policyName === 'batched' && this.batchWindowMs > 0) {
      this.startBatchTimer();
    }
  }

  startBatchTimer(): void {
    if (this.batchTimer) return;
    this.batchTimer = setInterval(() => {
      if (this.cycleInFlight) {
        this.skippedWindowCounter.inc();
        return;
      }
      this.runBatchCycle().catch((err: unknown) => {
        logger.error({ err }, 'scheduled batch matching cycle failed');
      });
    }, this.batchWindowMs);
  }

  stopBatchTimer(): void {
    if (this.batchTimer) {
      clearInterval(this.batchTimer);
      this.batchTimer = undefined;
    }
  }

  stop(): void {
    this.stopBatchTimer();
    this.regionPendingRides.clear();
  }

  setForceFallback(force: boolean): void {
    this.forceFallback = force;
  }

  getRegionForPoint(point: { lat: number; lng: number }): string {
    return latLngToCell(point.lat, point.lng, this.h3MatcherOwnerRes);
  }

  getPolicyName(): string {
    return this.policyName;
  }

  setPolicyName(name: string): void {
    this.policyName = name;
    if (name === 'batched' && this.batchWindowMs > 0) {
      this.startBatchTimer();
    } else {
      this.stopBatchTimer();
    }
  }

  getActiveRide(rideId: string): ActiveRideState | undefined {
    return this.activeRides.get(rideId);
  }

  registerRideState(state: ActiveRideState): void {
    this.activeRides.set(state.rideId, state);
  }

  /** Stop working on a ride (cancelled, terminal, or handed to a driver). */
  dropRide(rideId: string): void {
    this.activeRides.delete(rideId);
    for (const set of this.regionPendingRides.values()) set.delete(rideId);
  }

  private enqueueForBatch(ride: ActiveRideState): void {
    const region = this.getRegionForPoint(ride.pickup);
    let set = this.regionPendingRides.get(region);
    if (!set) {
      set = new Set<string>();
      this.regionPendingRides.set(region, set);
    }
    set.add(ride.rideId);
  }

  async handleRideRequested(event: RideRequestedEvent): Promise<void> {
    const { eventId, payload } = event;

    // 1. Idempotency check via processed_events table
    const existing = await this.options.db
      .select()
      .from(processedEvents)
      .where(eq(processedEvents.eventId, eventId))
      .limit(1);

    if (existing.length > 0) {
      return; // already processed
    }

    try {
      await this.options.db.insert(processedEvents).values({
        eventId,
        eventType: event.type,
        processedAt: new Date(),
      });
    } catch {
      return; // concurrent race handled
    }

    // 2. Initialize active ride state
    const rideState: ActiveRideState = {
      rideId: payload.rideId,
      riderId: payload.riderId,
      pickup: payload.pickup,
      dropoff: payload.dropoff,
      vehicleType: payload.vehicleType,
      requestedAtMs: new Date(payload.requestedAt).getTime(),
      attempts: 0,
      excludedDriverIds: new Set<string>(),
    };
    this.activeRides.set(payload.rideId, rideState);

    // 3. Move ride to MATCHING in core-api. If core refuses, the ride is not ours to dispatch.
    if (this.options.coreApiUrl) {
      try {
        await requestTransition(this.options.coreApiUrl, payload.rideId, {
          to: 'MATCHING',
          actor: 'SYSTEM',
        });
      } catch (err) {
        if (err instanceof RideStateError) {
          // e.g. rider cancelled before dispatch picked it up
          this.dropRide(payload.rideId);
          logger.warn({ err: err.message }, 'ride not dispatchable; dropped');
          return;
        }
        // Transient: keep the ride; startup/periodic recovery re-reads MATCHING rides from core.
        logger.error({ err, rideId: payload.rideId }, 'could not move ride to MATCHING');
        return;
      }
    }

    // 4. Trigger dispatching
    if (this.policyName === 'greedy') {
      await this.dispatchRide(payload.rideId);
    } else {
      this.enqueueForBatch(rideState);
    }
  }

  /**
   * Rebuild in-memory ride state from the durable sources (core-api ride row + offers table).
   * Returns undefined if the ride is gone or no longer dispatchable.
   */
  private async hydrateRide(row: CoreRideRow): Promise<ActiveRideState | undefined> {
    if (!DISPATCHABLE_STATUSES.has(row.status)) return undefined;

    const priorOffers = await this.options.db
      .select()
      .from(offers)
      .where(eq(offers.rideId, row.id));

    const excluded = new Set<string>();
    for (const o of priorOffers as Array<{ status: string; driverId: string }>) {
      if (o.status !== 'PENDING') excluded.add(o.driverId);
    }

    const state: ActiveRideState = {
      rideId: row.id,
      riderId: row.riderId,
      pickup: { lat: row.pickupLat, lng: row.pickupLng },
      dropoff: { lat: row.dropoffLat, lng: row.dropoffLng },
      vehicleType: 'sedan',
      requestedAtMs: new Date(row.createdAt).getTime(),
      attempts: (priorOffers as unknown[]).length,
      excludedDriverIds: excluded,
    };
    this.activeRides.set(row.id, state);
    return state;
  }

  private async loadRide(rideId: string): Promise<ActiveRideState | undefined> {
    const known = this.activeRides.get(rideId);
    if (known) return known;
    if (!this.options.coreApiUrl) return undefined;
    try {
      const res = await internalFetch(`${this.options.coreApiUrl}/rides/${rideId}`);
      if (!res.ok) return undefined;
      return await this.hydrateRide((await res.json()) as CoreRideRow);
    } catch (err) {
      logger.warn({ err, rideId }, 'could not load ride from core-api');
      return undefined;
    }
  }

  /**
   * Startup recovery: pick up rides that core-api still has in REQUESTED/MATCHING but that this
   * process knows nothing about (restart, crash). Without this they would wait forever.
   */
  async recoverPendingRides(): Promise<{ recovered: number }> {
    if (!this.options.coreApiUrl) return { recovered: 0 };
    let recovered = 0;
    const pageSize = 100;

    for (const status of ['REQUESTED', 'MATCHING'] as const) {
      for (let offset = 0; ; offset += pageSize) {
        const res = await internalFetch(
          `${this.options.coreApiUrl}/rides?status=${status}&limit=${pageSize}&offset=${offset}`,
        );
        if (!res.ok) {
          throw new Error(`core-api ride listing failed with HTTP ${res.status}`);
        }
        const page = (await res.json()) as CoreRideRow[];

        for (const row of page) {
          if (this.activeRides.has(row.id)) continue;
          const state = await this.hydrateRide(row);
          if (!state) continue;

          if (status === 'REQUESTED') {
            try {
              await requestTransition(this.options.coreApiUrl, row.id, {
                to: 'MATCHING',
                actor: 'SYSTEM',
              });
            } catch (err) {
              this.dropRide(row.id);
              logger.warn({ err, rideId: row.id }, 'recovery: ride could not enter MATCHING');
              continue;
            }
          }
          recovered += 1;
          if (this.policyName === 'greedy') {
            await this.dispatchRide(row.id);
          } else {
            this.enqueueForBatch(state);
          }
        }
        if (page.length < pageSize) break;
      }
    }
    return { recovered };
  }

  async dispatchRide(rideId: string): Promise<boolean> {
    const ride = await this.loadRide(rideId);
    if (!ride) {
      return false;
    }

    // Check attempts limit
    if (ride.attempts >= this.maxAttempts) {
      await this.handleNoDriverFound(rideId);
      return false;
    }

    // 1. Fetch available drivers near pickup
    const candidates = await this.fetchNearbyDrivers(ride.pickup);

    // 2. Filter out candidates already excluded or currently claimed
    const availableCandidates: DriverCandidate[] = [];
    for (const d of candidates) {
      if (ride.excludedDriverIds.has(d.id)) continue;
      const existingClaim = await this.options.claimService.getClaim(d.id);
      if (existingClaim) {
        continue;
      }
      availableCandidates.push(d);
    }

    if (availableCandidates.length === 0) {
      await this.handleNoDriverFound(rideId);
      return false;
    }

    // 3. Run MatchingPolicy
    const policy = this.options.matchingRegistry.get(this.policyName);
    const rideRequest: RideRequest = {
      id: ride.rideId,
      pickup: ride.pickup,
      requestedAtMs: ride.requestedAtMs,
      excludedDriverIds: Array.from(ride.excludedDriverIds),
    };

    const ctx: MatchContext = {
      nowMs: Date.now(),
      config: DEFAULT_MATCHING_CONFIG,
    };

    const result = policy.match([rideRequest], availableCandidates, ctx);
    if (result.assignments.length === 0) {
      await this.handleNoDriverFound(rideId);
      return false;
    }

    // 4. Create offer for best match
    const assignment = result.assignments[0]!;
    let offer;
    try {
      offer = await this.options.offerManager.createOffer({
        rideId: ride.rideId,
        driverId: assignment.driverId,
        pickup: ride.pickup,
        dropoff: ride.dropoff,
        pickupEtaSec: assignment.pickupEtaSec,
        cost: assignment.cost,
        policy: this.policyName,
      });
    } catch (err) {
      if (err instanceof RideStateError) {
        this.dropRide(rideId);
        return false;
      }
      logger.error({ err, rideId }, 'offer creation failed');
      return false;
    }

    if (!offer) {
      // Race: driver was claimed concurrently between check and Lua claim. Try the next one.
      ride.excludedDriverIds.add(assignment.driverId);
      return this.dispatchRide(rideId);
    }

    ride.attempts += 1;
    return true;
  }

  /**
   * One matching window. Calls are serialised: a second call waits for the first, so two windows
   * can never offer the same ride at once.
   */
  runBatchCycle(targetRegion?: string): Promise<{
    batchId: string;
    assignmentsCount: number;
    unmatchedCount: number;
    fallback: boolean;
  }> {
    const run = this.cycleChain.then(async () => {
      this.cycleInFlight = true;
      try {
        return await this.runBatchCycleExclusive(targetRegion);
      } finally {
        this.cycleInFlight = false;
      }
    });
    this.cycleChain = run.catch(() => undefined);
    return run;
  }

  private async runBatchCycleExclusive(targetRegion?: string): Promise<{
    batchId: string;
    assignmentsCount: number;
    unmatchedCount: number;
    fallback: boolean;
  }> {
    const batchId = randomUUID();
    const startMs = Date.now();
    const lagMs = startMs - this.lastBatchRunMs;
    this.lastBatchRunMs = startMs;

    const regionsToProcess = targetRegion
      ? [targetRegion]
      : Array.from(this.regionPendingRides.keys());

    let totalAssignments = 0;
    let totalUnmatched = 0;
    let usedFallback = false;

    // Greedy is used when forced, when windows are running late, or during the cooldown that
    // follows a slow or failed solve.
    const isLagFallback = lagMs > this.batchLagFallbackMs;
    const shouldFallback = this.forceFallback || isLagFallback || startMs < this.degradedUntilMs;

    if (shouldFallback) {
      usedFallback = true;
      this.fallbackCounter.inc();
    }

    for (const region of regionsToProcess) {
      const pendingSet = this.regionPendingRides.get(region);
      if (!pendingSet || pendingSet.size === 0) continue;

      const rideIds = Array.from(pendingSet);
      const eligibleRides: ActiveRideState[] = [];

      for (const rideId of rideIds) {
        const ride = this.activeRides.get(rideId);
        if (!ride) {
          pendingSet.delete(rideId);
          continue;
        }
        const waitedMs = startMs - ride.requestedAtMs;
        if (ride.attempts >= this.maxAttempts || waitedMs > this.matchingTimeoutMs) {
          pendingSet.delete(rideId);
          await this.handleNoDriverFound(rideId);
          totalUnmatched += 1;
        } else {
          eligibleRides.push(ride);
        }
      }

      if (eligibleRides.length === 0) continue;

      // Collect drivers near pickups of eligible rides
      const driversMap = new Map<string, DriverCandidate>();
      for (const ride of eligibleRides) {
        const nearby = await this.fetchNearbyDrivers(ride.pickup);
        for (const d of nearby) {
          if (!driversMap.has(d.id)) {
            const claim = await this.options.claimService.getClaim(d.id);
            if (!claim) {
              driversMap.set(d.id, d);
            }
          }
        }
      }

      const availableCandidates = Array.from(driversMap.values());
      const requests: RideRequest[] = eligibleRides.map((r) => ({
        id: r.rideId,
        pickup: r.pickup,
        requestedAtMs: r.requestedAtMs,
        excludedDriverIds: Array.from(r.excludedDriverIds),
      }));

      const ctx: MatchContext = {
        nowMs: Date.now(),
        config: DEFAULT_MATCHING_CONFIG,
      };

      // Choose policy; a solver that throws or is too slow must never strand the batch.
      const greedy = new GreedyPolicy();
      let policy: MatchingPolicy = shouldFallback
        ? greedy
        : this.options.matchingRegistry.get(this.policyName);
      let regionFellBack = shouldFallback;
      let result: MatchResult;
      const solveStart = Date.now();
      try {
        result = policy.match(requests, availableCandidates, ctx);
      } catch (err) {
        logger.error({ err, region, policy: policy.name }, 'batch solve failed; using greedy');
        this.batchErrorCounter.inc();
        if (!regionFellBack) this.fallbackCounter.inc();
        usedFallback = true;
        regionFellBack = true;
        this.degradedUntilMs = Date.now() + this.degradeCooldownMs;
        policy = greedy;
        result = greedy.match(requests, availableCandidates, ctx);
      }
      const solveMs = Date.now() - solveStart;
      if (!regionFellBack && solveMs > this.batchSolveBudgetMs) {
        logger.warn({ region, solveMs }, 'batch solve exceeded budget; greedy for next windows');
        this.degradedUntilMs = Date.now() + this.degradeCooldownMs;
      }

      // Process assignments
      for (const assignment of result.assignments) {
        const ride = this.activeRides.get(assignment.rideId);
        if (!ride) continue;

        try {
          const offer = await this.options.offerManager.createOffer({
            rideId: ride.rideId,
            driverId: assignment.driverId,
            pickup: ride.pickup,
            dropoff: ride.dropoff,
            pickupEtaSec: assignment.pickupEtaSec,
            cost: assignment.cost,
            policy: policy.name,
            batchId,
          });

          if (offer) {
            ride.attempts += 1;
            pendingSet.delete(ride.rideId);
            totalAssignments += 1;
          } else {
            // Concurrent claim collision: exclude driver, ride stays queued for the next window.
            ride.excludedDriverIds.add(assignment.driverId);
          }
        } catch (err) {
          if (err instanceof RideStateError) {
            pendingSet.delete(ride.rideId); // cancelled or otherwise no longer dispatchable
            this.dropRide(ride.rideId);
          } else {
            logger.error({ err, rideId: ride.rideId }, 'offer creation failed; will retry');
          }
        }
      }

      totalUnmatched += result.unmatchedRideIds.length;

      // Publish dispatch.batch.completed (informational)
      const durationMs = Date.now() - startMs;
      const batchEvent: DispatchBatchCompletedEvent = {
        eventId: randomUUID(),
        type: TOPICS.DISPATCH_BATCH_COMPLETED,
        version: 1,
        occurredAt: new Date().toISOString(),
        correlationId: batchId,
        payload: {
          batchId,
          region,
          policy: policy.name,
          fallback: regionFellBack,
          assignmentsCount: result.assignments.length,
          unmatchedCount: result.unmatchedRideIds.length,
          durationMs,
        },
      };

      if (this.options.producer) {
        try {
          await this.options.producer.publish(TOPICS.DISPATCH_BATCH_COMPLETED, region, batchEvent);
        } catch (err) {
          logger.error({ err }, 'dispatch.batch.completed publish failed');
        }
      }
      await this.notifyRealtime(`region:${region}`, 'DISPATCH_BATCH_COMPLETED', batchEvent.payload);
    }

    const durationSec = (Date.now() - startMs) / 1000;
    this.batchDurationHistogram.observe(durationSec);

    return {
      batchId,
      assignmentsCount: totalAssignments,
      unmatchedCount: totalUnmatched,
      fallback: usedFallback,
    };
  }

  async handleReofferNeeded(rideId: string, excludedDriverId: string): Promise<void> {
    // After a restart the in-memory state is gone: rebuild it from core-api + the offers table.
    const ride = await this.loadRide(rideId);
    if (!ride) return;
    ride.excludedDriverIds.add(excludedDriverId);

    if (this.policyName === 'batched') {
      this.enqueueForBatch(ride);
    } else {
      await this.dispatchRide(rideId);
    }
  }

  private async handleNoDriverFound(rideId: string): Promise<void> {
    this.dropRide(rideId);

    if (this.options.coreApiUrl) {
      try {
        await requestTransition(this.options.coreApiUrl, rideId, {
          to: 'NO_DRIVER_FOUND',
          actor: 'SYSTEM',
        });
      } catch (err) {
        if (err instanceof RideStateError) {
          return; // already cancelled/terminal: nothing to tell the rider
        }
        logger.error({ err, rideId }, 'could not move ride to NO_DRIVER_FOUND');
      }
    }

    await this.notifyRealtime(`ride:${rideId}`, 'NO_DRIVER_FOUND', { rideId });
  }

  private async fetchNearbyDrivers(pickup: {
    lat: number;
    lng: number;
  }): Promise<DriverCandidate[]> {
    if (!this.options.locationUrl) {
      return [];
    }

    try {
      const url = `${this.options.locationUrl}/drivers/nearby?lat=${pickup.lat}&lng=${pickup.lng}&radiusKm=10&status=AVAILABLE&limit=50`;
      const res = await internalFetch(url);
      if (!res.ok) {
        return [];
      }

      const list = (await res.json()) as Array<{
        driverId: string;
        lat: number;
        lng: number;
        ts: string;
      }>;

      return list.map((item) => ({
        id: item.driverId,
        location: { lat: item.lat, lng: item.lng },
        idleSinceMs: new Date(item.ts).getTime(),
      }));
    } catch {
      return [];
    }
  }

  // --- Drive the trip ---

  /** The driver acting on a ride must be the one whose offer was accepted. */
  private async assertDriverAssigned(rideId: string, driverId: string): Promise<void> {
    const rows = await this.options.db
      .select()
      .from(offers)
      .where(
        and(
          eq(offers.rideId, rideId),
          eq(offers.driverId, driverId),
          eq(offers.status, 'ACCEPTED'),
        ),
      )
      .limit(1);
    if (rows.length === 0) {
      throw AppError.forbidden('Driver is not assigned to this ride');
    }
  }

  /** Move the ride in core-api; translate "the state machine said no" into a 409. */
  private async driveRide(
    rideId: string,
    to: 'DRIVER_ARRIVED' | 'IN_PROGRESS' | 'COMPLETED',
  ): Promise<void> {
    if (!this.options.coreApiUrl) return;
    try {
      await requestTransition(this.options.coreApiUrl, rideId, { to, actor: 'DRIVER' });
    } catch (err) {
      if (err instanceof RideStateError) {
        throw AppError.conflict(`Ride cannot move to ${to} from its current state`, {
          detail: err.detail,
        });
      }
      throw err;
    }
  }

  async driverArrived(rideId: string, driverId: string): Promise<void> {
    await this.assertDriverAssigned(rideId, driverId);
    await this.driveRide(rideId, 'DRIVER_ARRIVED');
    await this.notifyRealtime(`ride:${rideId}`, 'DRIVER_ARRIVED', { rideId, driverId });
    await this.notifyRealtime(`driver:${driverId}`, 'DRIVER_ARRIVED', { rideId, driverId });
  }

  async startTrip(rideId: string, driverId: string): Promise<void> {
    await this.assertDriverAssigned(rideId, driverId);
    await this.driveRide(rideId, 'IN_PROGRESS');
    await this.notifyRealtime(`ride:${rideId}`, 'IN_PROGRESS', { rideId, driverId });
    await this.notifyRealtime(`driver:${driverId}`, 'IN_PROGRESS', { rideId, driverId });
  }

  async completeTrip(rideId: string, driverId: string): Promise<void> {
    await this.assertDriverAssigned(rideId, driverId);
    await this.driveRide(rideId, 'COMPLETED');

    // Release driver claim (trip claim is owned by the ride id)
    await this.options.claimService.releaseClaim(driverId, rideId);
    this.dropRide(rideId);

    await this.notifyRealtime(`ride:${rideId}`, 'COMPLETED', { rideId, driverId });
    await this.notifyRealtime(`driver:${driverId}`, 'COMPLETED', { rideId, driverId });
  }

  private async notifyRealtime(room: string, type: string, data: unknown): Promise<void> {
    if (this.options.redisPubSub) {
      try {
        const payload = JSON.stringify({
          eventId: `${Date.now()}-0`,
          room,
          type,
          data,
          ts: new Date().toISOString(),
        });
        await this.options.redisPubSub.publish(`pubsub:room:${room}`, payload);
      } catch {
        // realtime fan-out is best effort
      }
    }

    if (this.options.gatewayBroadcastUrl) {
      try {
        await internalFetch(`${this.options.gatewayBroadcastUrl}/events/broadcast`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ room, type, data }),
        });
      } catch {
        // realtime fan-out is best effort
      }
    }
  }
}
