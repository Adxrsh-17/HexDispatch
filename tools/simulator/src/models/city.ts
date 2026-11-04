import { latLngToCell } from 'h3-js';
import { haversineMeters, type LatLng } from '@hexdispatch/matching';
import type { SeededRng } from '../rng/seeded-rng';

export interface Hotspot {
  id: string;
  name: string;
  center: LatLng;
  radiusMeters: number;
  weight: number;
}

export interface CityConfig {
  center: LatLng;
  radiusKm: number;
  baseSpeedMps?: number;
  speedMultiplier?: number;
  hotspots?: Hotspot[];
}

export const H3_RES_8 = 8;

export const DEFAULT_HOTSPOTS: Hotspot[] = [
  {
    id: 'cbd',
    name: 'Central Business District (MG Road)',
    center: { lat: 12.975, lng: 77.605 },
    radiusMeters: 2000,
    weight: 3.0,
  },
  {
    id: 'tech_south',
    name: 'Koramangala Tech Hub',
    center: { lat: 12.9352, lng: 77.6245 },
    radiusMeters: 2500,
    weight: 3.5,
  },
  {
    id: 'tech_east',
    name: 'Indiranagar Commercial Hub',
    center: { lat: 12.9784, lng: 77.6408 },
    radiusMeters: 2000,
    weight: 2.5,
  },
  {
    id: 'residential_south',
    name: 'Jayanagar Residential',
    center: { lat: 12.9308, lng: 77.5838 },
    radiusMeters: 2500,
    weight: 1.5,
  },
  {
    id: 'residential_north',
    name: 'Malleshwaram Residential',
    center: { lat: 13.0031, lng: 77.5643 },
    radiusMeters: 2500,
    weight: 1.5,
  },
];

export class CityModel {
  readonly center: LatLng;
  readonly radiusKm: number;
  readonly baseSpeedMps: number;
  speedMultiplier: number;
  readonly hotspots: Hotspot[];

  constructor(config: CityConfig) {
    this.center = config.center;
    this.radiusKm = config.radiusKm;
    this.baseSpeedMps = config.baseSpeedMps ?? 8.33; // ~30 km/h
    this.speedMultiplier = config.speedMultiplier ?? 1.0;
    this.hotspots = config.hotspots ?? DEFAULT_HOTSPOTS;
  }

  getH3Cell(loc: LatLng): string {
    return latLngToCell(loc.lat, loc.lng, H3_RES_8);
  }

  /**
   * Calculates travel time in seconds between two points given traffic / weather multiplier.
   */
  getTravelTimeSec(from: LatLng, to: LatLng, additionalSpeedMultiplier = 1.0): number {
    const distMeters = haversineMeters(from, to);
    const effectiveSpeed = Math.max(
      1.0,
      this.baseSpeedMps * this.speedMultiplier * additionalSpeedMultiplier,
    );
    return Math.max(1, distMeters / effectiveSpeed);
  }

  /**
   * Pick a random location within a radius around an anchor coordinate.
   */
  randomPointNear(center: LatLng, radiusMeters: number, rng: SeededRng): LatLng {
    // Uniform sampling in a disk
    const r = Math.sqrt(rng.next()) * radiusMeters;
    const theta = rng.next() * 2 * Math.PI;

    // Approximations in meters to degrees
    const deltaLat = (r * Math.cos(theta)) / 111_320;
    const deltaLng = (r * Math.sin(theta)) / (111_320 * Math.cos((center.lat * Math.PI) / 180));

    return {
      lat: Number((center.lat + deltaLat).toFixed(6)),
      lng: Number((center.lng + deltaLng).toFixed(6)),
    };
  }

  /**
   * Generates a random point in the city, either in a hotspot (weighted) or general area.
   */
  randomPointInCity(rng: SeededRng, preferHotspots = true): LatLng {
    if (preferHotspots && this.hotspots.length > 0 && rng.boolean(0.75)) {
      const hotspot = rng.pickWeighted(this.hotspots.map((h) => ({ item: h, weight: h.weight })));
      return this.randomPointNear(hotspot.center, hotspot.radiusMeters, rng);
    }
    return this.randomPointNear(this.center, this.radiusKm * 1000, rng);
  }
}
