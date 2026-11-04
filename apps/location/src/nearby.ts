import { latLngToCell, gridDisk } from 'h3-js';
import { haversineMeters } from '@hexdispatch/matching';
import { type DriverIndex, type StoredDriverLocation, H3_CELL_RES } from './driver-index';

export interface NearbyOptions {
  lat: number;
  lng: number;
  radiusKm?: number;
  limit?: number;
  status?: 'AVAILABLE' | 'ON_OFFER' | 'ON_TRIP' | 'OFFLINE';
  maxRing?: number;
}

export interface CandidateDriver extends StoredDriverLocation {
  distanceMeters: number;
}

export class NearbySearch {
  constructor(private driverIndex: DriverIndex) {}

  async findNearby(options: NearbyOptions): Promise<CandidateDriver[]> {
    const { lat, lng, radiusKm = 5, limit = 10, status = 'AVAILABLE', maxRing = 10 } = options;

    const maxDistanceMeters = radiusKm * 1000;
    const centerCell = latLngToCell(lat, lng, H3_CELL_RES);
    const candidateMap = new Map<string, CandidateDriver>();
    const visitedCells = new Set<string>();

    for (let ring = 0; ring <= maxRing; ring++) {
      const diskCells = gridDisk(centerCell, ring);
      const newCells = diskCells.filter((c) => !visitedCells.has(c));

      for (const cell of newCells) {
        visitedCells.add(cell);
        const drivers = await this.driverIndex.getDriversInCell(cell);

        for (const d of drivers) {
          if (status && d.status !== status) continue;

          const dist = haversineMeters({ lat, lng }, { lat: d.lat, lng: d.lng });
          if (dist <= maxDistanceMeters) {
            candidateMap.set(d.driverId, {
              ...d,
              distanceMeters: Math.round(dist),
            });
          }
        }
      }

      // If we have enough candidates and finished searching the current radius ring
      if (candidateMap.size >= limit) {
        break;
      }
    }

    const sorted = Array.from(candidateMap.values()).sort(
      (a, b) => a.distanceMeters - b.distanceMeters,
    );

    return sorted.slice(0, limit);
  }
}
