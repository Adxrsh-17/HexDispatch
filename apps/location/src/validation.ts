import { z } from 'zod';
import { AppError } from '@hexdispatch/shared';
import { haversineMeters } from '@hexdispatch/matching';
import type { StoredDriverLocation } from './driver-index';

export const locationPingSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  heading: z.number().min(0).max(360).optional(),
  speedMps: z.number().min(0).optional(),
  status: z.enum(['AVAILABLE', 'ON_OFFER', 'ON_TRIP', 'OFFLINE']).default('AVAILABLE'),
  ts: z
    .string()
    .datetime()
    .default(() => new Date().toISOString()),
});

export type LocationPingInput = z.infer<typeof locationPingSchema>;

export const MAX_PING_AGE_SEC = 60;
export const MAX_FUTURE_SKEW_SEC = 5;
export const MAX_PLAUSIBLE_SPEED_MPS = 85; // ~306 km/h

export function validatePingFreshnessAndSanity(
  ping: LocationPingInput,
  previousPing: StoredDriverLocation | null,
  nowMs: number = Date.now(),
): void {
  const pingTimeMs = new Date(ping.ts).getTime();

  // Freshness check: reject older than MAX_PING_AGE_SEC
  if (nowMs - pingTimeMs > MAX_PING_AGE_SEC * 1000) {
    throw AppError.badRequest(`Location ping is too stale (older than ${MAX_PING_AGE_SEC}s)`);
  }

  // Future check: reject pings more than MAX_FUTURE_SKEW_SEC ahead
  if (pingTimeMs - nowMs > MAX_FUTURE_SKEW_SEC * 1000) {
    throw AppError.badRequest('Location ping timestamp is too far in the future');
  }

  if (previousPing) {
    const prevTimeMs = new Date(previousPing.ts).getTime();

    // Out-of-order check
    if (pingTimeMs <= prevTimeMs) {
      throw AppError.badRequest(
        `Out-of-order ping rejected: received ts ${ping.ts} <= previous ts ${previousPing.ts}`,
      );
    }

    // Speed sanity check (teleportation protection)
    const distanceM = haversineMeters(
      { lat: previousPing.lat, lng: previousPing.lng },
      { lat: ping.lat, lng: ping.lng },
    );
    const deltaTimeSec = (pingTimeMs - prevTimeMs) / 1000;

    if (deltaTimeSec > 0) {
      const impliedSpeed = distanceM / deltaTimeSec;
      if (impliedSpeed > MAX_PLAUSIBLE_SPEED_MPS) {
        throw AppError.badRequest(
          `Speed sanity check failed: implied speed ${Math.round(impliedSpeed)} m/s exceeds max threshold (${MAX_PLAUSIBLE_SPEED_MPS} m/s)`,
        );
      }
    }
  }
}
