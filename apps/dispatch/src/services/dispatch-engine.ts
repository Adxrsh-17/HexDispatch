import { eq } from 'drizzle-orm';
import type { RideRequestedEvent } from '@hexdispatch/contracts';
import {
  type DriverCandidate,
  type RideRequest,
  type MatchContext,
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
  private policyName: string;
  private maxAttempts: number;

  constructor(private options: DispatchEngineOptions) {
    this.policyName = options.matchingPolicy ?? 'greedy';
    this.maxAttempts = options.maxOfferAttempts ?? 3;
  }

  getPolicyName(): string {
    return this.policyName;
  }

  setPolicyName(name: string): void {
    this.policyName = name;
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
    await this.dispatchRide(payload.rideId);
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

  async handleReofferNeeded(rideId: string, excludedDriverId: string): Promise<void> {
    const ride = this.activeRides.get(rideId);
    if (ride) {
      ride.excludedDriverIds.add(excludedDriverId);
    }
    await this.dispatchRide(rideId);
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
