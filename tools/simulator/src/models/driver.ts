import { haversineMeters, type LatLng } from '@hexdispatch/matching';
import type { CityModel } from './city';
import type { SeededRng } from '../rng/seeded-rng';

export type DriverStatus = 'OFFLINE' | 'IDLE' | 'ON_OFFER' | 'DISPATCHED' | 'ON_TRIP';

export interface DriverConfig {
  id: string;
  initialLocation: LatLng;
  shiftStartSec: number;
  shiftEndSec: number;
  baseAcceptanceRate?: number;
}

export interface OfferDecision {
  accept: boolean;
  isTimeout: boolean;
  responseDelaySec: number;
}

export class SimDriver {
  readonly id: string;
  location: LatLng;
  status: DriverStatus = 'OFFLINE';
  readonly shiftStartSec: number;
  readonly shiftEndSec: number;
  readonly baseAcceptanceRate: number;

  // State transitions & tracking
  idleSinceSec = 0;
  statusChangedAtSec = 0;
  currentOfferId?: string;
  currentRideId?: string;

  // Cumulative metrics
  totalEarningsCents = 0;
  completedTrips = 0;
  declinedOffers = 0;
  timedOutOffers = 0;
  acceptedOffers = 0;

  totalIdleTimeSec = 0;
  totalDispatchedTimeSec = 0;
  totalTripTimeSec = 0;
  totalDistanceMeters = 0;

  constructor(config: DriverConfig) {
    this.id = config.id;
    this.location = config.initialLocation;
    this.shiftStartSec = config.shiftStartSec;
    this.shiftEndSec = config.shiftEndSec;
    this.baseAcceptanceRate = config.baseAcceptanceRate ?? 0.92;
  }

  transitionStatus(newStatus: DriverStatus, timeSec: number): void {
    const elapsed = Math.max(0, timeSec - this.statusChangedAtSec);
    if (this.status === 'IDLE') {
      this.totalIdleTimeSec += elapsed;
    } else if (this.status === 'DISPATCHED') {
      this.totalDispatchedTimeSec += elapsed;
    } else if (this.status === 'ON_TRIP') {
      this.totalTripTimeSec += elapsed;
    }

    this.status = newStatus;
    this.statusChangedAtSec = timeSec;
    if (newStatus === 'IDLE') {
      this.idleSinceSec = timeSec;
    }
  }

  /**
   * Deterministically decides whether driver accepts, declines, or lets the offer time out.
   */
  evaluateOffer(
    pickupEtaSec: number,
    offerTtlSec: number,
    acceptanceRng: SeededRng,
  ): OfferDecision {
    // 1. Check for timeout behavior (driver missed ping / asleep / distraction ~3% chance)
    if (acceptanceRng.boolean(0.03)) {
      return {
        accept: false,
        isTimeout: true,
        responseDelaySec: offerTtlSec + 0.1, // triggers after TTL
      };
    }

    // 2. Acceptance probability degrades slightly if pickup ETA is long
    const distancePenalty = Math.min(0.25, (pickupEtaSec / 600) * 0.25);
    const pAccept = Math.max(0.4, this.baseAcceptanceRate - distancePenalty);

    const willAccept = acceptanceRng.boolean(pAccept);
    // Response delay between 1.5s and 6.0s (before offer timeout)
    const responseDelaySec = acceptanceRng.nextFloat(1.5, Math.min(6.0, offerTtlSec - 1.0));

    return {
      accept: willAccept,
      isTimeout: false,
      responseDelaySec,
    };
  }

  /**
   * Completes a trip, credits fare, and tracks distance.
   */
  completeTrip(
    pickup: LatLng,
    dropoff: LatLng,
    timeSec: number,
    surgeMultiplier = 1.0,
  ): { fareCents: number; tripDistanceMeters: number } {
    const tripDist = haversineMeters(pickup, dropoff);
    this.totalDistanceMeters += tripDist;
    this.location = { ...dropoff };

    // Standard stub fare: $5.00 base + $1.50/km ($0.0015/m)
    const baseCents = 500;
    const distanceCents = Math.round((tripDist / 1000) * 150);
    const subtotal = baseCents + distanceCents;
    const fareCents = Math.round(subtotal * surgeMultiplier);

    this.totalEarningsCents += fareCents;
    this.completedTrips += 1;
    this.currentRideId = undefined;
    this.currentOfferId = undefined;

    this.transitionStatus('IDLE', timeSec);
    return { fareCents, tripDistanceMeters: tripDist };
  }

  /**
   * Idle roaming: step ~150-300m towards closest hotspot or roam randomly.
   */
  roam(city: CityModel, driverRng: SeededRng, timeSec: number, biasTarget?: LatLng): void {
    if (this.status !== 'IDLE') return;

    const elapsed = Math.max(0, timeSec - this.statusChangedAtSec);
    this.totalIdleTimeSec += elapsed;
    this.statusChangedAtSec = timeSec;

    let target = biasTarget;
    if (!target) {
      target = city.center;
      // Find closest hotspot to drift towards
      let minDist = Infinity;
      for (const h of city.hotspots) {
        const d = haversineMeters(this.location, h.center);
        if (d < minDist) {
          minDist = d;
          target = h.center;
        }
      }
    }

    // Move ~200 meters towards target with small directional noise
    const stepMeters = driverRng.nextFloat(150, 300);
    const angle = Math.atan2(target.lat - this.location.lat, target.lng - this.location.lng);
    const noisyAngle = angle + driverRng.nextFloat(-0.5, 0.5);

    const deltaLat = (stepMeters * Math.sin(noisyAngle)) / 111_320;
    const deltaLng =
      (stepMeters * Math.cos(noisyAngle)) /
      (111_320 * Math.cos((this.location.lat * Math.PI) / 180));

    this.location = {
      lat: Number((this.location.lat + deltaLat).toFixed(6)),
      lng: Number((this.location.lng + deltaLng).toFixed(6)),
    };
    this.totalDistanceMeters += stepMeters;
    this.statusChangedAtSec = timeSec;
  }
}
