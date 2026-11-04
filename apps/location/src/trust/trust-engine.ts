import { randomUUID } from 'node:crypto';
import { haversineMeters } from '@hexdispatch/matching';
import { TOPICS, type TrustFlaggedEvent } from '@hexdispatch/contracts';

export type TrustReason =
  'IMPOSSIBLE_SPEED' | 'TELEPORT_JUMP' | 'FROZEN_GPS' | 'ROUTE_DEVIATION' | 'CANCELLATION_ABUSE';

export interface LocationPingInput {
  lat: number;
  lng: number;
  status: 'AVAILABLE' | 'ON_OFFER' | 'ON_TRIP' | 'OFFLINE';
  timestampMs: number;
}

export interface TrustFlagRecord {
  id: string;
  subjectId: string;
  subjectType: 'DRIVER' | 'RIDER';
  reason: TrustReason;
  riskScore: number;
  details: Record<string, unknown>;
  flaggedAt: string;
}

export interface DriverStateTracker {
  lastPing?: LocationPingInput;
  frozenSinceMs?: number;
  riskScore: number;
  flags: TrustFlagRecord[];
}

export interface TrustEngineOptions {
  maxSpeedMps?: number; // default 42 m/s (~151 km/h)
  teleportDistanceMeters?: number; // default 500m jump
  frozenGpsThresholdSec?: number; // default 300s (5 min) during ON_TRIP
  cancellationThresholdCount?: number; // default 4 cancellations
  cancellationWindowSec?: number; // default 3600s (1 hr)
  producer?: {
    publish: (topic: string, key: string, payload: unknown) => Promise<void>;
  };
}

export class TrustEngine {
  private maxSpeedMps: number;
  private teleportDistanceMeters: number;
  private frozenGpsThresholdSec: number;
  private cancellationThresholdCount: number;
  private cancellationWindowSec: number;

  private driverStates = new Map<string, DriverStateTracker>();
  private cancellationHistory = new Map<
    string,
    Array<{ timestampMs: number; isCancelled: boolean }>
  >();

  private allFlags: TrustFlagRecord[] = [];

  constructor(private options: TrustEngineOptions = {}) {
    this.maxSpeedMps = options.maxSpeedMps ?? 42; // ~150 km/h
    this.teleportDistanceMeters = options.teleportDistanceMeters ?? 500;
    this.frozenGpsThresholdSec = options.frozenGpsThresholdSec ?? 300;
    this.cancellationThresholdCount = options.cancellationThresholdCount ?? 4;
    this.cancellationWindowSec = options.cancellationWindowSec ?? 3600;
  }

  getDriverTracker(driverId: string): DriverStateTracker {
    let tracker = this.driverStates.get(driverId);
    if (!tracker) {
      tracker = { riskScore: 0, flags: [] };
      this.driverStates.set(driverId, tracker);
    }
    return tracker;
  }

  async evaluateLocationPing(
    driverId: string,
    ping: LocationPingInput,
  ): Promise<{ isAnomaly: boolean; flag?: TrustFlagRecord }> {
    const tracker = this.getDriverTracker(driverId);
    const prev = tracker.lastPing;

    if (!prev) {
      tracker.lastPing = ping;
      return { isAnomaly: false };
    }

    const deltaSec = Math.max(0.001, (ping.timestampMs - prev.timestampMs) / 1000);
    const distMeters = haversineMeters(
      { lat: prev.lat, lng: prev.lng },
      { lat: ping.lat, lng: ping.lng },
    );
    const speedMps = distMeters / deltaSec;

    let flag: TrustFlagRecord | undefined;

    // 1. Impossible Speed & Teleport Jumps
    if (speedMps > this.maxSpeedMps && distMeters > this.teleportDistanceMeters) {
      const isTeleport = speedMps > 100 || distMeters > 2000;
      const reason: TrustReason = isTeleport ? 'TELEPORT_JUMP' : 'IMPOSSIBLE_SPEED';
      const riskScore = Math.min(100, Math.round(speedMps * 1.5));

      flag = {
        id: randomUUID(),
        subjectId: driverId,
        subjectType: 'DRIVER',
        reason,
        riskScore,
        details: {
          speedMps: Number(speedMps.toFixed(2)),
          speedKmh: Number((speedMps * 3.6).toFixed(1)),
          distanceMeters: Number(distMeters.toFixed(1)),
          deltaSec: Number(deltaSec.toFixed(2)),
        },
        flaggedAt: new Date(ping.timestampMs).toISOString(),
      };
    }
    // 2. Frozen GPS during ON_TRIP
    else if (ping.status === 'ON_TRIP') {
      if (distMeters < 5) {
        if (!tracker.frozenSinceMs) {
          tracker.frozenSinceMs = prev.timestampMs;
        }
        const frozenDurationSec = (ping.timestampMs - tracker.frozenSinceMs) / 1000;
        if (frozenDurationSec >= this.frozenGpsThresholdSec) {
          flag = {
            id: randomUUID(),
            subjectId: driverId,
            subjectType: 'DRIVER',
            reason: 'FROZEN_GPS',
            riskScore: 75,
            details: {
              frozenDurationSec,
              location: { lat: ping.lat, lng: ping.lng },
            },
            flaggedAt: new Date(ping.timestampMs).toISOString(),
          };
        }
      } else {
        tracker.frozenSinceMs = undefined;
      }
    } else {
      tracker.frozenSinceMs = undefined;
    }

    tracker.lastPing = ping;

    if (flag) {
      tracker.flags.push(flag);
      tracker.riskScore = Math.max(tracker.riskScore, flag.riskScore);
      this.allFlags.push(flag);

      if (this.options.producer) {
        const event: TrustFlaggedEvent = {
          eventId: randomUUID(),
          type: TOPICS.TRUST_FLAGGED,
          version: 1,
          occurredAt: flag.flaggedAt,
          correlationId: driverId,
          payload: {
            subjectId: driverId,
            subjectType: 'DRIVER',
            reason: flag.reason,
            riskScore: flag.riskScore,
            details: flag.details,
            flaggedAt: flag.flaggedAt,
          },
        };
        await this.options.producer.publish(TOPICS.TRUST_FLAGGED, driverId, event);
      }

      return { isAnomaly: true, flag };
    }

    return { isAnomaly: false };
  }

  // --- Cancellation Abuse Detection (Task 2) ---

  async recordRideOutcome(params: {
    subjectId: string;
    subjectType: 'DRIVER' | 'RIDER';
    isCancelled: boolean;
    timestampMs?: number;
  }): Promise<{ isAbuser: boolean; flag?: TrustFlagRecord }> {
    const { subjectId, subjectType, isCancelled, timestampMs = Date.now() } = params;

    let history = this.cancellationHistory.get(subjectId);
    if (!history) {
      history = [];
      this.cancellationHistory.set(subjectId, history);
    }

    history.push({ timestampMs, isCancelled });

    // Prune history older than window
    const cutoff = timestampMs - this.cancellationWindowSec * 1000;
    history = history.filter((h) => h.timestampMs >= cutoff);
    this.cancellationHistory.set(subjectId, history);

    const totalRides = history.length;
    const cancelCount = history.filter((h) => h.isCancelled).length;
    const cancelRate = totalRides > 0 ? cancelCount / totalRides : 0;

    if (cancelCount >= this.cancellationThresholdCount && cancelRate >= 0.6) {
      const flag: TrustFlagRecord = {
        id: randomUUID(),
        subjectId,
        subjectType,
        reason: 'CANCELLATION_ABUSE',
        riskScore: 85,
        details: {
          cancelCount,
          totalRides,
          cancelRate: Number((cancelRate * 100).toFixed(1)),
          windowSec: this.cancellationWindowSec,
        },
        flaggedAt: new Date(timestampMs).toISOString(),
      };

      if (subjectType === 'DRIVER') {
        const tracker = this.getDriverTracker(subjectId);
        tracker.flags.push(flag);
        tracker.riskScore = Math.max(tracker.riskScore, flag.riskScore);
      }
      this.allFlags.push(flag);

      if (this.options.producer) {
        const event: TrustFlaggedEvent = {
          eventId: randomUUID(),
          type: TOPICS.TRUST_FLAGGED,
          version: 1,
          occurredAt: flag.flaggedAt,
          correlationId: subjectId,
          payload: {
            subjectId,
            subjectType,
            reason: 'CANCELLATION_ABUSE',
            riskScore: flag.riskScore,
            details: flag.details,
            flaggedAt: flag.flaggedAt,
          },
        };
        await this.options.producer.publish(TOPICS.TRUST_FLAGGED, subjectId, event);
      }

      return { isAbuser: true, flag };
    }

    return { isAbuser: false };
  }

  getAllFlags(): readonly TrustFlagRecord[] {
    return this.allFlags;
  }
}
