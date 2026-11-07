import type { LatLng } from '@hexdispatch/matching';
import type { SimDriver } from '../models/driver';

export interface CompletedRideRecord {
  rideId: string;
  driverId: string;
  requestedAtSec: number;
  matchedAtSec: number;
  pickupEtaSec: number;
  pickupArrivedAtSec: number;
  completedAtSec: number;
  tripDurationSec: number;
  fareCents: number;
  pickup: LatLng;
  dropoff: LatLng;
}

export interface AbandonedRideRecord {
  rideId: string;
  requestedAtSec: number;
  endedAtSec: number;
  reason: 'PRICE_SURGE_ABANDONED' | 'PATIENCE_EXPIRED';
}

export interface NoDriverRideRecord {
  rideId: string;
  requestedAtSec: number;
  endedAtSec: number;
  attempts: number;
  reason: 'NO_DRIVER_FOUND' | 'MAX_ATTEMPTS_EXCEEDED';
}

export interface StillWaitingRideRecord {
  rideId: string;
  requestedAtSec: number;
  endedAtSec: number;
  assignedDriverId?: string;
}

export interface UnmatchedRideRecord {
  rideId: string;
  requestedAtSec: number;
  attempts: number;
  reason:
    | 'NO_DRIVER_FOUND'
    | 'MAX_ATTEMPTS_EXCEEDED'
    | 'TIMEOUT'
    | 'PRICE_SURGE_ABANDONED'
    | 'PATIENCE_EXPIRED';
}

export interface SimMetrics {
  totalRequests: number;
  completedRides: number;
  abandonedRides: number;
  noDriverRides: number;
  stillWaitingAtEnd: number;

  completionRate: number; // completedRides / totalRequests
  sharePickedUpWithin5Min: number; // share of ALL requests picked up within 300s
  meanPickupWaitSec: number; // computed over ALL requests with unserved censored
  p95PickupWaitSec: number; // 95th percentile over ALL requests with unserved censored

  driverUtilisation: number;
  ridesPerDriverHour: number;
  earningsSpread: number; // Gini coefficient of driver earnings

  // Legacy & supplementary fields
  matchedRides: number;
  unmatchedRides: number;
  surgeAbandonedRides: number;
  cancelledRides: number;
  matchRate: number;
  noDriverRate: number;
  cancellationRate: number;

  pickupEtaAvgSec: number;
  pickupEtaP95Sec: number;
  pickupEtaMedianSec: number;

  totalDriverShiftHours: number;
  idleTimeAvgSec: number;
  totalFareRevenueCents: number;
  avgDriverEarningsCents: number;
  giniCoefficient: number;
  p90p10EarningsRatio: number;
}

export class MetricsCollector {
  private completedRides: CompletedRideRecord[] = [];
  private abandonedRides: AbandonedRideRecord[] = [];
  private noDriverRides: NoDriverRideRecord[] = [];
  private stillWaitingRides: StillWaitingRideRecord[] = [];
  private cancelledCount = 0;
  private totalRequestsCount = 0;

  recordRequest(): void {
    this.totalRequestsCount += 1;
  }

  recordCancellation(): void {
    this.cancelledCount += 1;
  }

  recordCompletedRide(record: CompletedRideRecord): void {
    this.completedRides.push(record);
  }

  recordAbandoned(record: AbandonedRideRecord): void {
    this.abandonedRides.push(record);
  }

  recordNoDriver(record: NoDriverRideRecord): void {
    this.noDriverRides.push(record);
  }

  recordStillWaiting(record: StillWaitingRideRecord): void {
    this.stillWaitingRides.push(record);
  }

  /** Backwards compatibility helper */
  recordUnmatchedRide(record: {
    rideId: string;
    requestedAtSec: number;
    attempts: number;
    reason: string;
    endedAtSec?: number;
  }): void {
    const endedAtSec = record.endedAtSec ?? record.requestedAtSec;
    if (
      record.reason === 'PRICE_SURGE_ABANDONED' ||
      record.reason === 'PATIENCE_EXPIRED' ||
      record.reason === 'TIMEOUT'
    ) {
      this.abandonedRides.push({
        rideId: record.rideId,
        requestedAtSec: record.requestedAtSec,
        endedAtSec,
        reason:
          record.reason === 'PRICE_SURGE_ABANDONED' ? 'PRICE_SURGE_ABANDONED' : 'PATIENCE_EXPIRED',
      });
    } else {
      this.noDriverRides.push({
        rideId: record.rideId,
        requestedAtSec: record.requestedAtSec,
        endedAtSec,
        attempts: record.attempts,
        reason: 'NO_DRIVER_FOUND',
      });
    }
  }

  calculate(drivers: readonly SimDriver[], durationSec: number): SimMetrics {
    const totalRequests = this.totalRequestsCount;
    const completedCount = this.completedRides.length;
    const abandonedCount = this.abandonedRides.length;
    const noDriverCount = this.noDriverRides.length;
    const stillWaitingCount = this.stillWaitingRides.length;
    const unmatchedCount = abandonedCount + noDriverCount + stillWaitingCount;

    const surgeAbandonedRides = this.abandonedRides.filter(
      (r) => r.reason === 'PRICE_SURGE_ABANDONED',
    ).length;

    const completionRate = totalRequests > 0 ? completedCount / totalRequests : 0;
    const matchRate = completionRate;
    const noDriverRate = totalRequests > 0 ? (noDriverCount + abandonedCount) / totalRequests : 0;
    const cancellationRate = totalRequests > 0 ? this.cancelledCount / totalRequests : 0;

    // Share picked up within 5 minutes (300 s) over ALL requests
    let pickedUpWithin5MinCount = 0;
    for (const r of this.completedRides) {
      const waitSec = r.pickupArrivedAtSec - r.requestedAtSec;
      if (waitSec <= 300) {
        pickedUpWithin5MinCount += 1;
      }
    }
    const sharePickedUpWithin5Min = totalRequests > 0 ? pickedUpWithin5MinCount / totalRequests : 0;

    // Pickup wait for ALL requests (with unserved censored at abandonment or end time)
    const allWaitTimesSec: number[] = [];
    for (const r of this.completedRides) {
      allWaitTimesSec.push(Math.max(0, r.pickupArrivedAtSec - r.requestedAtSec));
    }
    for (const r of this.abandonedRides) {
      allWaitTimesSec.push(Math.max(0, r.endedAtSec - r.requestedAtSec));
    }
    for (const r of this.noDriverRides) {
      allWaitTimesSec.push(Math.max(0, r.endedAtSec - r.requestedAtSec));
    }
    for (const r of this.stillWaitingRides) {
      allWaitTimesSec.push(Math.max(0, r.endedAtSec - r.requestedAtSec));
    }

    allWaitTimesSec.sort((a, b) => a - b);
    const meanPickupWaitSec =
      allWaitTimesSec.length > 0
        ? allWaitTimesSec.reduce((sum, v) => sum + v, 0) / allWaitTimesSec.length
        : 0;

    const p95Idx =
      allWaitTimesSec.length > 0
        ? Math.min(allWaitTimesSec.length - 1, Math.floor(allWaitTimesSec.length * 0.95))
        : 0;
    const p95PickupWaitSec = allWaitTimesSec.length > 0 ? allWaitTimesSec[p95Idx]! : 0;

    // Pickup ETAs over completed rides (legacy reporting)
    const etas = this.completedRides.map((r) => r.pickupEtaSec).sort((a, b) => a - b);
    const pickupEtaAvgSec = etas.length > 0 ? etas.reduce((sum, v) => sum + v, 0) / etas.length : 0;
    const completedP95Idx =
      etas.length > 0 ? Math.min(etas.length - 1, Math.floor(etas.length * 0.95)) : 0;
    const pickupEtaP95Sec = etas.length > 0 ? etas[completedP95Idx]! : 0;
    const medianIndex = etas.length > 0 ? Math.floor(etas.length * 0.5) : 0;
    const pickupEtaMedianSec = etas.length > 0 ? etas[medianIndex]! : 0;

    // Driver stats
    let totalDriverShiftSec = 0;
    let totalUtilizedSec = 0;
    let totalIdleSec = 0;
    let totalRevenueCents = 0;
    const earningsList: number[] = [];

    for (const d of drivers) {
      d.transitionStatus(d.status, durationSec);

      const shiftDurationSec = Math.max(1, d.shiftEndSec - d.shiftStartSec);
      totalDriverShiftSec += shiftDurationSec;
      totalUtilizedSec += d.totalTripTimeSec + d.totalDispatchedTimeSec;
      totalIdleSec += d.totalIdleTimeSec;
      totalRevenueCents += d.totalEarningsCents;
      earningsList.push(d.totalEarningsCents);
    }

    const driverUtilisation = totalDriverShiftSec > 0 ? totalUtilizedSec / totalDriverShiftSec : 0;
    const idleTimeAvgSec = drivers.length > 0 ? totalIdleSec / drivers.length : 0;
    const totalDriverShiftHours = totalDriverShiftSec / 3600;
    const ridesPerDriverHour =
      totalDriverShiftHours > 0 ? completedCount / totalDriverShiftHours : 0;
    const avgDriverEarningsCents = drivers.length > 0 ? totalRevenueCents / drivers.length : 0;

    // Gini coefficient
    const giniCoefficient = calculateGini(earningsList);
    const p90p10EarningsRatio = calculateP90P10Ratio(earningsList);

    return {
      totalRequests,
      completedRides: completedCount,
      abandonedRides: abandonedCount,
      noDriverRides: noDriverCount,
      stillWaitingAtEnd: stillWaitingCount,

      completionRate: Number(completionRate.toFixed(4)),
      sharePickedUpWithin5Min: Number(sharePickedUpWithin5Min.toFixed(4)),
      meanPickupWaitSec: Number(meanPickupWaitSec.toFixed(2)),
      p95PickupWaitSec: Number(p95PickupWaitSec.toFixed(2)),

      driverUtilisation: Number(driverUtilisation.toFixed(4)),
      ridesPerDriverHour: Number(ridesPerDriverHour.toFixed(2)),
      earningsSpread: Number(giniCoefficient.toFixed(4)),

      matchedRides: completedCount,
      unmatchedRides: unmatchedCount,
      surgeAbandonedRides,
      cancelledRides: this.cancelledCount,
      matchRate: Number(matchRate.toFixed(4)),
      noDriverRate: Number(noDriverRate.toFixed(4)),
      cancellationRate: Number(cancellationRate.toFixed(4)),

      pickupEtaAvgSec: Number(pickupEtaAvgSec.toFixed(2)),
      pickupEtaP95Sec: Number(pickupEtaP95Sec.toFixed(2)),
      pickupEtaMedianSec: Number(pickupEtaMedianSec.toFixed(2)),

      totalDriverShiftHours: Number(totalDriverShiftHours.toFixed(2)),
      idleTimeAvgSec: Number(idleTimeAvgSec.toFixed(2)),
      totalFareRevenueCents: totalRevenueCents,
      avgDriverEarningsCents: Number(avgDriverEarningsCents.toFixed(2)),
      giniCoefficient: Number(giniCoefficient.toFixed(4)),
      p90p10EarningsRatio: Number(p90p10EarningsRatio.toFixed(2)),
    };
  }

  getCompletedRides(): readonly CompletedRideRecord[] {
    return this.completedRides;
  }

  getAbandonedRides(): readonly AbandonedRideRecord[] {
    return this.abandonedRides;
  }

  getNoDriverRides(): readonly NoDriverRideRecord[] {
    return this.noDriverRides;
  }

  getStillWaitingRides(): readonly StillWaitingRideRecord[] {
    return this.stillWaitingRides;
  }
}

export function calculateGini(values: number[]): number {
  if (values.length <= 1) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  let sum = 0;
  let weightedSum = 0;

  for (let i = 0; i < n; i++) {
    const val = sorted[i]!;
    sum += val;
    weightedSum += (i + 1) * val;
  }

  if (sum === 0) return 0;
  return (2 * weightedSum) / (n * sum) - (n + 1) / n;
}

export function calculateP90P10Ratio(values: number[]): number {
  if (values.length === 0) return 1.0;
  const sorted = [...values].sort((a, b) => a - b);
  const p10Idx = Math.floor(sorted.length * 0.1);
  const p90Idx = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9));

  const p10 = sorted[p10Idx]!;
  const p90 = sorted[p90Idx]!;

  if (p10 === 0) {
    return p90 === 0 ? 1.0 : Number((p90 / 100).toFixed(2));
  }
  return Number((p90 / p10).toFixed(2));
}
