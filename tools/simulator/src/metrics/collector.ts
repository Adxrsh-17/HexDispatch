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

export interface UnmatchedRideRecord {
  rideId: string;
  requestedAtSec: number;
  attempts: number;
  reason: 'NO_DRIVER_FOUND' | 'MAX_ATTEMPTS_EXCEEDED' | 'TIMEOUT' | 'PRICE_SURGE_ABANDONED';
}

export interface SimMetrics {
  totalRequests: number;
  matchedRides: number;
  completedRides: number;
  unmatchedRides: number;
  surgeAbandonedRides: number;
  cancelledRides: number;

  matchRate: number; // completedRides / totalRequests
  noDriverRate: number; // unmatchedRides / totalRequests
  cancellationRate: number;

  pickupEtaAvgSec: number;
  pickupEtaP95Sec: number;
  pickupEtaMedianSec: number;

  totalDriverShiftHours: number;
  driverUtilisation: number;
  idleTimeAvgSec: number;
  ridesPerDriverHour: number;

  totalFareRevenueCents: number;
  avgDriverEarningsCents: number;
  giniCoefficient: number;
  p90p10EarningsRatio: number;
}

export class MetricsCollector {
  private completedRides: CompletedRideRecord[] = [];
  private unmatchedRides: UnmatchedRideRecord[] = [];
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

  recordUnmatchedRide(record: UnmatchedRideRecord): void {
    this.unmatchedRides.push(record);
  }

  calculate(drivers: readonly SimDriver[], durationSec: number): SimMetrics {
    const totalRequests = this.totalRequestsCount;
    const completedCount = this.completedRides.length;
    const unmatchedCount = this.unmatchedRides.length;
    const surgeAbandonedRides = this.unmatchedRides.filter(
      (r) => r.reason === 'PRICE_SURGE_ABANDONED',
    ).length;

    const matchRate = totalRequests > 0 ? completedCount / totalRequests : 0;
    const noDriverRate = totalRequests > 0 ? unmatchedCount / totalRequests : 0;
    const cancellationRate = totalRequests > 0 ? this.cancelledCount / totalRequests : 0;

    // Pickup ETAs
    const etas = this.completedRides.map((r) => r.pickupEtaSec).sort((a, b) => a - b);
    const pickupEtaAvgSec = etas.length > 0 ? etas.reduce((sum, v) => sum + v, 0) / etas.length : 0;

    const p95Index = Math.min(etas.length - 1, Math.floor(etas.length * 0.95));
    const pickupEtaP95Sec = etas.length > 0 ? etas[p95Index]! : 0;

    const medianIndex = Math.floor(etas.length * 0.5);
    const pickupEtaMedianSec = etas.length > 0 ? etas[medianIndex]! : 0;

    // Driver stats
    let totalDriverShiftSec = 0;
    let totalUtilizedSec = 0;
    let totalIdleSec = 0;
    let totalRevenueCents = 0;
    const earningsList: number[] = [];

    for (const d of drivers) {
      // Finalize any ongoing state slice up to durationSec
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
      matchedRides: completedCount,
      completedRides: completedCount,
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
      driverUtilisation: Number(driverUtilisation.toFixed(4)),
      idleTimeAvgSec: Number(idleTimeAvgSec.toFixed(2)),
      ridesPerDriverHour: Number(ridesPerDriverHour.toFixed(2)),
      totalFareRevenueCents: totalRevenueCents,
      avgDriverEarningsCents: Number(avgDriverEarningsCents.toFixed(2)),
      giniCoefficient: Number(giniCoefficient.toFixed(4)),
      p90p10EarningsRatio: Number(p90p10EarningsRatio.toFixed(2)),
    };
  }

  getCompletedRides(): readonly CompletedRideRecord[] {
    return this.completedRides;
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
