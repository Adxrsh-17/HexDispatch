import { eq } from 'drizzle-orm';
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
  GreedyPolicy,
  DEFAULT_MATCHING_CONFIG,
} from '@hexdispatch/matching';
import { processedEvents } from '../db/schema';
import type { OfferManager } from './offer-manager';
import type { MatchingRegistry } from './matching-registry';
import type { DriverClaimService } from './driver-claim';
import type Redis from 'ioredis';

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

export class DispatchEngine {
  private activeRides = new Map<string, ActiveRideState>();
  private regionPendingRides = new Map<string, Set<string>>();
  private policyName: string;
  private maxAttempts: number;
  private batchWindowMs: number;
  private batchLagFallbackMs: number;
  private h3MatcherOwnerRes: number;
  private batchTimer?: NodeJS.Timeout;
  private lastBatchRunMs = Date.now();
  private forceFallback = false;

  readonly fallbackCounter: Counter<string>;
  readonly batchDurationHistogram: Histogram<string>;

  constructor(private options: DispatchEngineOptions) {
    this.policyName = options.matchingPolicy ?? 'greedy';
    this.maxAttempts = options.maxOfferAttempts ?? 3;
    this.batchWindowMs = options.batchWindowMs ?? 2000;
    this.batchLagFallbackMs = options.batchLagFallbackMs ?? 5000;
    this.h3MatcherOwnerRes = options.h3MatcherOwnerRes ?? 6;

    const registry = options.metricsRegistry;
    this.fallbackCounter = new Counter({
      name: 'dispatch_fallback_total',
      help: 'Total number of batch matching fallbacks to greedy',
      registers: registry ? [registry] : [],
    });
    this.batchDurationHistogram = new Histogram({
      name: 'dispatch_batch_duration_seconds',
      help: 'Duration of batch matching cycles in seconds',
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
      registers: registry ? [registry] : [],
    });

    if (this.policyName === 'batched' && this.batchWindowMs > 0) {
      this.startBatchTimer();
    }
  }

  startBatchTimer(): void {
    if (this.batchTimer) return;
    this.batchTimer = setInterval(() => {
      this.runBatchCycle().catch((err) => {
        console.error('Error during scheduled batch matching cycle:', err);
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

    // 3. Move ride to MATCHING in core-api
    if (this.options.coreApiUrl) {
      try {
        await fetch(`${this.options.coreApiUrl}/rides/${payload.rideId}/transition`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ to: 'MATCHING', actor: 'SYSTEM' }),
        });
      } catch (err) {
        console.error(`Failed to move ride ${payload.rideId} to MATCHING:`, err);
      }
    }

    // 4. Trigger dispatching
    if (this.policyName === 'greedy') {
      await this.dispatchRide(payload.rideId);
    } else {
      // In batched mode: add to region pending queue
      const region = this.getRegionForPoint(payload.pickup);
      let set = this.regionPendingRides.get(region);
      if (!set) {
        set = new Set<string>();
        this.regionPendingRides.set(region, set);
      }
      set.add(payload.rideId);
    }
  }

  async dispatchRide(rideId: string): Promise<boolean> {
    let ride = this.activeRides.get(rideId);
    if (!ride) {
      // Try to construct minimal ride state from core-api if available
      if (this.options.coreApiUrl) {
        try {
          const res = await fetch(`${this.options.coreApiUrl}/rides/${rideId}`);
          if (res.ok) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Ride row
            const data = (await res.json()) as any;
            ride = {
              rideId: data.id,
              riderId: data.riderId,
              pickup: data.pickup ?? { lat: data.pickupLat, lng: data.pickupLng },
              dropoff: data.dropoff ?? { lat: data.dropoffLat, lng: data.dropoffLng },
              vehicleType: data.vehicleType,
              requestedAtMs: new Date(data.createdAt).getTime(),
              attempts: 0,
              excludedDriverIds: new Set<string>(),
            };
            this.activeRides.set(rideId, ride);
          }
        } catch {
          // ignore
        }
      }
    }

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
    ride.attempts += 1;

    const offer = await this.options.offerManager.createOffer({
      rideId: ride.rideId,
      driverId: assignment.driverId,
      pickup: ride.pickup,
      dropoff: ride.dropoff,
      pickupEtaSec: assignment.pickupEtaSec,
      cost: assignment.cost,
      policy: this.policyName,
    });

    if (!offer) {
      // Race: driver was claimed concurrently between check and Lua claim.
      // Exclude driver for this round and retry immediately.
      ride.excludedDriverIds.add(assignment.driverId);
      return this.dispatchRide(rideId);
    }

    return true;
  }

  async runBatchCycle(targetRegion?: string): Promise<{
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

    // Check lag fallback
    const isLagFallback = lagMs > this.batchLagFallbackMs;
    const shouldFallback = this.forceFallback || isLagFallback;

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
        if (ride.attempts >= this.maxAttempts) {
          await this.handleNoDriverFound(rideId);
          pendingSet.delete(rideId);
          totalUnmatched += 1;
        } else {
          eligibleRides.push(ride);
        }
      }

      if (eligibleRides.length === 0) continue;

      // Choose policy (if fallback, use GreedyPolicy; else BatchedPolicy)
      const policy = shouldFallback
        ? new GreedyPolicy()
        : this.options.matchingRegistry.get(this.policyName);

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

      const result = policy.match(requests, availableCandidates, ctx);

      // Process assignments
      for (const assignment of result.assignments) {
        const ride = this.activeRides.get(assignment.rideId);
        if (!ride) continue;

        ride.attempts += 1;
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
          pendingSet.delete(ride.rideId);
          totalAssignments += 1;
        } else {
          // Concurrent claim collision: exclude driver and leave ride in pendingSet
          ride.excludedDriverIds.add(assignment.driverId);
        }
      }

      totalUnmatched += result.unmatchedRideIds.length;

      // Publish dispatch.batch.completed
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
          fallback: shouldFallback,
          assignmentsCount: result.assignments.length,
          unmatchedCount: result.unmatchedRideIds.length,
          durationMs,
        },
      };

      if (this.options.producer) {
        await this.options.producer.publish(TOPICS.DISPATCH_BATCH_COMPLETED, region, batchEvent);
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
    const ride = this.activeRides.get(rideId);
    if (ride) {
      ride.excludedDriverIds.add(excludedDriverId);
    }
    if (this.policyName === 'batched') {
      if (ride) {
        const region = this.getRegionForPoint(ride.pickup);
        let set = this.regionPendingRides.get(region);
        if (!set) {
          set = new Set<string>();
          this.regionPendingRides.set(region, set);
        }
        set.add(rideId);
      }
    } else {
      await this.dispatchRide(rideId);
    }
  }

  private async handleNoDriverFound(rideId: string): Promise<void> {
    this.activeRides.delete(rideId);

    if (this.options.coreApiUrl) {
      try {
        await fetch(`${this.options.coreApiUrl}/rides/${rideId}/transition`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ to: 'NO_DRIVER_FOUND', actor: 'SYSTEM' }),
        });
      } catch (err) {
        console.error(`Failed to move ride ${rideId} to NO_DRIVER_FOUND:`, err);
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
      const res = await fetch(url);
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

  // --- Drive Trip Endpoints (Task 5) ---

  async driverArrived(rideId: string, driverId: string): Promise<void> {
    if (this.options.coreApiUrl) {
      await fetch(`${this.options.coreApiUrl}/rides/${rideId}/transition`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ to: 'DRIVER_ARRIVED', driverId, actor: 'DRIVER' }),
      });
    }

    await this.notifyRealtime(`ride:${rideId}`, 'DRIVER_ARRIVED', { rideId, driverId });
    await this.notifyRealtime(`driver:${driverId}`, 'DRIVER_ARRIVED', { rideId, driverId });
  }

  async startTrip(rideId: string, driverId: string): Promise<void> {
    if (this.options.coreApiUrl) {
      await fetch(`${this.options.coreApiUrl}/rides/${rideId}/transition`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ to: 'IN_TRIP', driverId, actor: 'DRIVER' }),
      });
    }

    await this.notifyRealtime(`ride:${rideId}`, 'IN_TRIP', { rideId, driverId });
    await this.notifyRealtime(`driver:${driverId}`, 'IN_TRIP', { rideId, driverId });
  }

  async completeTrip(rideId: string, driverId: string): Promise<void> {
    if (this.options.coreApiUrl) {
      await fetch(`${this.options.coreApiUrl}/rides/${rideId}/transition`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ to: 'COMPLETED', driverId, actor: 'DRIVER' }),
      });
    }

    // Release driver claim
    await this.options.claimService.forceRelease(driverId);
    this.activeRides.delete(rideId);

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
        // ignore
      }
    }

    if (this.options.gatewayBroadcastUrl) {
      try {
        await fetch(`${this.options.gatewayBroadcastUrl}/events/broadcast`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ room, type, data }),
        });
      } catch {
        // ignore
      }
    }
  }
}
