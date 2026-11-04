import { haversineMeters, type LatLng } from '@hexdispatch/matching';
import type { CityModel } from './city';
import type { SeededRng } from '../rng/seeded-rng';

export interface BurstEvent {
  id: string;
  name: string;
  startSec: number;
  durationSec: number;
  multiplier: number;
  hotspotId?: string;
}

export interface DiurnalPoint {
  timeSec: number;
  factor: number;
}

export interface DemandConfig {
  baseArrivalRatePerHour: number;
  bursts?: BurstEvent[];
  diurnalCurve?: DiurnalPoint[];
}

export interface GeneratedRide {
  id: string;
  pickup: LatLng;
  dropoff: LatLng;
  requestedAtSec: number;
}

export class DemandModel {
  readonly baseRatePerSec: number;
  readonly bursts: BurstEvent[];
  readonly diurnalCurve: DiurnalPoint[];

  constructor(config: DemandConfig) {
    this.baseRatePerSec = Math.max(0.001, config.baseArrivalRatePerHour / 3600);
    this.bursts = config.bursts ?? [];
    this.diurnalCurve = config.diurnalCurve ?? [];
  }

  getEffectiveRate(timeSec: number): number {
    let factor = 1.0;

    // 1. Time-of-day curve (piecewise linear interpolation if curve specified)
    if (this.diurnalCurve.length > 0) {
      factor = this.interpolateDiurnal(timeSec);
    }

    // 2. Active bursts
    for (const burst of this.bursts) {
      if (timeSec >= burst.startSec && timeSec <= burst.startSec + burst.durationSec) {
        factor *= burst.multiplier;
      }
    }

    return this.baseRatePerSec * factor;
  }

  private interpolateDiurnal(timeSec: number): number {
    const points = this.diurnalCurve;
    if (points.length === 0) return 1.0;
    if (timeSec <= points[0]!.timeSec) return points[0]!.factor;
    if (timeSec >= points[points.length - 1]!.timeSec) return points[points.length - 1]!.factor;

    for (let i = 0; i < points.length - 1; i++) {
      const p1 = points[i]!;
      const p2 = points[i + 1]!;
      if (timeSec >= p1.timeSec && timeSec <= p2.timeSec) {
        const ratio = (timeSec - p1.timeSec) / (p2.timeSec - p1.timeSec);
        return p1.factor + ratio * (p2.factor - p1.factor);
      }
    }
    return 1.0;
  }

  /**
   * Samples next arrival time delta via exponential distribution (Poisson process).
   */
  sampleInterArrivalTimeSec(timeSec: number, rng: SeededRng): number {
    const lambda = this.getEffectiveRate(timeSec);
    return rng.nextExponential(lambda);
  }

  /**
   * Generates a new ride request with geographically sensible pickup & dropoff coordinates.
   */
  generateRide(id: string, timeSec: number, city: CityModel, rng: SeededRng): GeneratedRide {
    // Check if an active burst is bound to a specific hotspot
    let pickupHotspot = '';
    for (const burst of this.bursts) {
      if (
        burst.hotspotId &&
        timeSec >= burst.startSec &&
        timeSec <= burst.startSec + burst.durationSec
      ) {
        pickupHotspot = burst.hotspotId;
        break;
      }
    }

    let pickup: LatLng;
    if (pickupHotspot) {
      const targetHotspot = city.hotspots.find((h) => h.id === pickupHotspot);
      if (targetHotspot) {
        pickup = city.randomPointNear(targetHotspot.center, targetHotspot.radiusMeters, rng);
      } else {
        pickup = city.randomPointInCity(rng);
      }
    } else {
      pickup = city.randomPointInCity(rng);
    }

    // Generate dropoff ensuring at least 500m distance from pickup
    let dropoff = city.randomPointInCity(rng);
    let attempts = 0;
    while (haversineMeters(pickup, dropoff) < 500 && attempts < 10) {
      dropoff = city.randomPointInCity(rng);
      attempts++;
    }

    return {
      id,
      pickup,
      dropoff,
      requestedAtSec: timeSec,
    };
  }
}
