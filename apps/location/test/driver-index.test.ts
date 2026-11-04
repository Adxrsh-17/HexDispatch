import { describe, it, expect, beforeEach } from 'vitest';
import RedisMock from 'ioredis-mock';
import { DriverIndex } from '../src/driver-index';
import { validatePingFreshnessAndSanity } from '../src/validation';

describe('Driver Index & Cell Invariants (AC2)', () => {
  let redis: InstanceType<typeof RedisMock>;
  let driverIndex: DriverIndex;

  beforeEach(() => {
    redis = new RedisMock();
    driverIndex = new DriverIndex(redis, 2); // 2 second TTL
  });

  describe('Single-Cell Invariant on Movement', () => {
    it('a driver crossing cells appears in exactly one cell set at all times', async () => {
      const driverId = 'driver-crossing-1';

      // Position 1: Indiranagar, Bangalore
      const loc1 = {
        driverId,
        lat: 12.9716,
        lng: 77.5946,
        status: 'AVAILABLE' as const,
        ts: new Date('2026-11-04T10:00:00Z').toISOString(),
      };

      const res1 = await driverIndex.updateLocation(loc1);
      const cell1 = res1.cell;

      // Assert in cell 1
      const inCell1 = await redis.sismember(`cell:${cell1}:drivers`, driverId);
      expect(inCell1).toBe(1);

      // Position 2: Whitefield, Bangalore (~15 km away, distinct H3 res 8 cell)
      const loc2 = {
        driverId,
        lat: 12.9698,
        lng: 77.7499,
        status: 'AVAILABLE' as const,
        ts: new Date('2026-11-04T10:05:00Z').toISOString(),
      };

      const res2 = await driverIndex.updateLocation(loc2);
      const cell2 = res2.cell;
      expect(cell2).not.toBe(cell1);

      // Assert removed from cell 1
      const inCell1After = await redis.sismember(`cell:${cell1}:drivers`, driverId);
      expect(inCell1After).toBe(0);

      // Assert present in cell 2
      const inCell2After = await redis.sismember(`cell:${cell2}:drivers`, driverId);
      expect(inCell2After).toBe(1);

      // Check all cell keys in Redis: driverId must appear in exactly one cell set
      const allCellKeys: string[] = await redis.keys('cell:*:drivers');
      let totalOccurrences = 0;
      for (const key of allCellKeys) {
        const isMem = await redis.sismember(key, driverId);
        if (isMem === 1) totalOccurrences += 1;
      }
      expect(totalOccurrences).toBe(1);
    });
  });

  describe('TTL Expiration & Stale Driver Eviction', () => {
    it('stale drivers disappear after TTL expiry', async () => {
      const driverId = 'driver-expiring-1';
      const loc = {
        driverId,
        lat: 12.9716,
        lng: 77.5946,
        status: 'AVAILABLE' as const,
        ts: new Date().toISOString(),
      };

      const { cell } = await driverIndex.updateLocation(loc);

      // Immediately present
      const initial = await driverIndex.getDriversInCell(cell);
      expect(initial.map((d) => d.driverId)).toContain(driverId);

      // Simulate TTL expiration by deleting the driver hash
      await redis.del(`driver:${driverId}`);

      // Querying cell sets detects hash expiration and prunes stale driver
      const afterExpiry = await driverIndex.getDriversInCell(cell);
      expect(afterExpiry.map((d) => d.driverId)).not.toContain(driverId);

      // Verify pruned from the Redis set as well
      const isMember = await redis.sismember(`cell:${cell}:drivers`, driverId);
      expect(isMember).toBe(0);
    });
  });

  describe('Ping Validation & Speed Sanity', () => {
    it('rejects out-of-order pings', () => {
      const prev = {
        driverId: 'd1',
        lat: 12.97,
        lng: 77.59,
        status: 'AVAILABLE' as const,
        cell: '88618925d3fffff',
        ts: '2026-11-04T10:00:10Z',
      };

      // Stale timestamp (earlier than previous)
      const outOfOrderPing = {
        lat: 12.971,
        lng: 77.591,
        status: 'AVAILABLE' as const,
        ts: '2026-11-04T10:00:05Z',
      };

      expect(() =>
        validatePingFreshnessAndSanity(
          outOfOrderPing,
          prev,
          new Date('2026-11-04T10:00:20Z').getTime(),
        ),
      ).toThrowError(/Out-of-order ping rejected/);
    });

    it('rejects impossible vehicle speeds (teleportation)', () => {
      const prev = {
        driverId: 'd1',
        lat: 12.9716,
        lng: 77.5946,
        status: 'AVAILABLE' as const,
        cell: '88618925d3fffff',
        ts: '2026-11-04T10:00:00Z',
      };

      // In 2 seconds, jumped 50km (impossible speed > MAX_PLAUSIBLE_SPEED_MPS)
      const teleportPing = {
        lat: 13.4,
        lng: 77.5946,
        status: 'AVAILABLE' as const,
        ts: '2026-11-04T10:00:02Z',
      };

      expect(() =>
        validatePingFreshnessAndSanity(
          teleportPing,
          prev,
          new Date('2026-11-04T10:00:05Z').getTime(),
        ),
      ).toThrowError(/Speed sanity check failed/);
    });
  });
});
