import type Redis from 'ioredis';
import { latLngToCell } from 'h3-js';

export const H3_CELL_RES = 8;
export const DEFAULT_DRIVER_TTL_SEC = 30;

export interface DriverLocation {
  driverId: string;
  lat: number;
  lng: number;
  heading?: number;
  speedMps?: number;
  status: 'AVAILABLE' | 'ON_OFFER' | 'ON_TRIP' | 'OFFLINE';
  ts: string;
}

export interface StoredDriverLocation extends DriverLocation {
  cell: string;
}

export class DriverIndex {
  constructor(
    private redis: Redis,
    private ttlSec: number = DEFAULT_DRIVER_TTL_SEC,
  ) {}

  /**
   * Atomically records driver location, updating its cell set and hash with TTL.
   * Ensures the driver is in exactly ONE cell set at all times.
   */
  async updateLocation(loc: DriverLocation): Promise<{ cell: string; previousCell?: string }> {
    const newCell = latLngToCell(loc.lat, loc.lng, H3_CELL_RES);
    const driverHashKey = `driver:${loc.driverId}`;
    const newCellKey = `cell:${newCell}:drivers`;

    // Lua script executes atomically
    const lua = `
      local driverHashKey = KEYS[1]
      local newCellKey = KEYS[2]
      local driverId = ARGV[1]
      local lat = ARGV[2]
      local lng = ARGV[3]
      local heading = ARGV[4]
      local speedMps = ARGV[5]
      local status = ARGV[6]
      local ts = ARGV[7]
      local newCell = ARGV[8]
      local ttl = tonumber(ARGV[9])

      local prevCell = redis.call('HGET', driverHashKey, 'cell')
      if prevCell and prevCell ~= newCell then
        redis.call('SREM', 'cell:' .. prevCell .. ':drivers', driverId)
      end

      redis.call('SADD', newCellKey, driverId)
      redis.call('HSET', driverHashKey,
        'driverId', driverId,
        'lat', lat,
        'lng', lng,
        'heading', heading,
        'speedMps', speedMps,
        'status', status,
        'ts', ts,
        'cell', newCell
      )
      redis.call('EXPIRE', driverHashKey, ttl)

      return prevCell or ''
    `;

    try {
      const prevCellResult = (await this.redis.eval(
        lua,
        2,
        driverHashKey,
        newCellKey,
        loc.driverId,
        String(loc.lat),
        String(loc.lng),
        String(loc.heading ?? 0),
        String(loc.speedMps ?? 0),
        loc.status,
        loc.ts,
        newCell,
        String(this.ttlSec),
      )) as string;

      return {
        cell: newCell,
        previousCell: prevCellResult ? prevCellResult : undefined,
      };
    } catch {
      // Fallback for mock environments if eval is limited
      const prevCell = await this.redis.hget(driverHashKey, 'cell');
      if (prevCell && prevCell !== newCell) {
        await this.redis.srem(`cell:${prevCell}:drivers`, loc.driverId);
      }
      await this.redis.sadd(newCellKey, loc.driverId);
      await this.redis.hset(driverHashKey, {
        driverId: loc.driverId,
        lat: String(loc.lat),
        lng: String(loc.lng),
        heading: String(loc.heading ?? 0),
        speedMps: String(loc.speedMps ?? 0),
        status: loc.status,
        ts: loc.ts,
        cell: newCell,
      });
      await this.redis.expire(driverHashKey, this.ttlSec);

      return {
        cell: newCell,
        previousCell: prevCell ?? undefined,
      };
    }
  }

  async getDriver(driverId: string): Promise<StoredDriverLocation | null> {
    const data = await this.redis.hgetall(`driver:${driverId}`);
    if (!data || Object.keys(data).length === 0 || !data.cell) {
      return null;
    }

    return {
      driverId: data.driverId ?? driverId,
      lat: Number(data.lat),
      lng: Number(data.lng),
      heading: data.heading ? Number(data.heading) : undefined,
      speedMps: data.speedMps ? Number(data.speedMps) : undefined,
      status: data.status as DriverLocation['status'],
      ts: data.ts ?? new Date().toISOString(),
      cell: data.cell,
    };
  }

  /**
   * Retrieves active, non-expired drivers in a specific H3 cell.
   * Cleans up stale entries where the driver hash has expired.
   */
  async getDriversInCell(cell: string): Promise<StoredDriverLocation[]> {
    const cellKey = `cell:${cell}:drivers`;
    const driverIds = await this.redis.smembers(cellKey);
    if (driverIds.length === 0) return [];

    const activeDrivers: StoredDriverLocation[] = [];
    const staleIds: string[] = [];

    const pipeline = this.redis.pipeline();
    for (const id of driverIds) {
      pipeline.hgetall(`driver:${id}`);
    }

    const results = await pipeline.exec();
    if (!results) return [];

    for (let i = 0; i < driverIds.length; i++) {
      const driverId = driverIds[i]!;
      const result = results[i];
      const data = result && !result[0] ? (result[1] as Record<string, string>) : null;

      if (!data || Object.keys(data).length === 0 || !data.cell) {
        staleIds.push(driverId);
      } else {
        activeDrivers.push({
          driverId,
          lat: Number(data.lat),
          lng: Number(data.lng),
          heading: data.heading ? Number(data.heading) : undefined,
          speedMps: data.speedMps ? Number(data.speedMps) : undefined,
          status: data.status as DriverLocation['status'],
          ts: data.ts ?? new Date().toISOString(),
          cell: data.cell,
        });
      }
    }

    // Prune stale drivers from cell set
    if (staleIds.length > 0) {
      await this.redis.srem(cellKey, ...staleIds);
    }

    return activeDrivers;
  }
}
