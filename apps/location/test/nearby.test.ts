import { describe, it, expect, beforeEach } from 'vitest';
import RedisMock from 'ioredis-mock';
import { DriverIndex } from '../src/driver-index';
import { NearbySearch } from '../src/nearby';
import { haversineMeters } from '@hexdispatch/matching';

describe('Nearby Search vs Brute-force Haversine (AC1)', () => {
  let redis: InstanceType<typeof RedisMock>;
  let driverIndex: DriverIndex;
  let nearbySearch: NearbySearch;

  beforeEach(() => {
    redis = new RedisMock();
    driverIndex = new DriverIndex(redis, 60);
    nearbySearch = new NearbySearch(driverIndex);
  });

  it('matches brute-force haversine search on randomised geographic data', async () => {
    const center = { lat: 12.9716, lng: 77.5946 };
    const radiusKm = 3;
    const radiusM = radiusKm * 1000;
    const limit = 15;

    // Seed 60 randomised drivers within ~5km bounding box
    const allDrivers: Array<{ driverId: string; lat: number; lng: number; status: 'AVAILABLE' }> =
      [];

    for (let i = 0; i < 60; i++) {
      // Deterministic pseudo-random jitter around center
      const angle = (i * 137.5 * Math.PI) / 180; // Golden angle distribution
      const r = (Math.sqrt(i) / Math.sqrt(60)) * 0.045; // ~0 to 5 km in degrees
      const lat = center.lat + r * Math.cos(angle);
      const lng = center.lng + r * Math.sin(angle);

      const driver = {
        driverId: `driver-test-${i}`,
        lat,
        lng,
        status: 'AVAILABLE' as const,
        ts: new Date().toISOString(),
      };

      allDrivers.push(driver);
      await driverIndex.updateLocation(driver);
    }

    // 1. Run Nearby H3 index search
    const nearbyResults = await nearbySearch.findNearby({
      lat: center.lat,
      lng: center.lng,
      radiusKm,
      limit,
      status: 'AVAILABLE',
      maxRing: 8,
    });

    // 2. Run Brute-Force haversine calculation across ALL drivers
    const bruteForceResults = allDrivers
      .map((d) => ({
        driverId: d.driverId,
        dist: Math.round(haversineMeters(center, { lat: d.lat, lng: d.lng })),
      }))
      .filter((d) => d.dist <= radiusM)
      .sort((a, b) => a.dist - b.dist)
      .slice(0, limit);

    expect(nearbyResults.length).toBeGreaterThan(0);
    expect(nearbyResults.length).toBe(bruteForceResults.length);

    // Verify ordering and returned driver IDs match brute-force haversine results
    for (let i = 0; i < nearbyResults.length; i++) {
      const nearby = nearbyResults[i]!;
      const brute = bruteForceResults[i]!;

      expect(nearby.driverId).toBe(brute.driverId);
      // Distance is identical within ±1m rounding
      expect(Math.abs(nearby.distanceMeters - brute.dist)).toBeLessThanOrEqual(1);
    }
  });
});
