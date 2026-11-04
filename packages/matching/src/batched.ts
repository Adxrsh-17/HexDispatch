import { pickupEtaSec } from './geo';
import { GreedyPolicy } from './greedy';
import { hungarian } from './hungarian';
import {
  DEFAULT_MATCHING_CONFIG,
  type Assignment,
  type DriverCandidate,
  type MatchContext,
  type MatchResult,
  type MatchingPolicy,
  type RideRequest,
} from './types';

const INFEASIBLE_COST = 10_000_000;
const byString = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Batched matching policy using Hungarian (Kuhn-Munkres) minimum-cost assignment.
 *
 * For each window, constructs a cost matrix:
 *   cost(r, d) = pickupETA(r, d) - idleBonus(d)
 * Riders have an "unmatched" dummy column:
 *   cost(r, unmatched) = unmatchedBaseCostSec + waitPenalty(r)
 *
 * An older rider has a higher waitPenalty, making skipping them more expensive.
 * Drivers with longer idle times receive an idleBonus (capped), balancing earnings.
 * Infeasible pairs (exceeded max ETA or excluded driver) receive a large cost and are rejected.
 */
export class BatchedPolicy implements MatchingPolicy {
  readonly name = 'batched';

  match(
    requests: readonly RideRequest[],
    drivers: readonly DriverCandidate[],
    ctx: MatchContext,
  ): MatchResult {
    if (requests.length === 0) {
      return { assignments: [], unmatchedRideIds: [] };
    }
    if (drivers.length === 0) {
      return { assignments: [], unmatchedRideIds: requests.map((r) => r.id) };
    }

    const maxCells = ctx.config.batchMaxCells ?? DEFAULT_MATCHING_CONFIG.batchMaxCells ?? 10_000;
    if (requests.length * drivers.length > maxCells) {
      // Large-batch fallback to GreedyPolicy
      return new GreedyPolicy().match(requests, drivers, ctx);
    }

    const sortedRequests = [...requests].sort(
      (a, b) => a.requestedAtMs - b.requestedAtMs || byString(a.id, b.id),
    );
    const sortedDrivers = [...drivers].sort((a, b) => byString(a.id, b.id));

    const R = sortedRequests.length;
    const D = sortedDrivers.length;
    const M = D + R;

    const idleWeight = ctx.config.idleWeight ?? DEFAULT_MATCHING_CONFIG.idleWeight ?? 0.1;
    const maxIdleBonusSec =
      ctx.config.maxIdleBonusSec ?? DEFAULT_MATCHING_CONFIG.maxIdleBonusSec ?? 120;
    const waitWeight = ctx.config.waitWeight ?? DEFAULT_MATCHING_CONFIG.waitWeight ?? 0.2;
    const unmatchedBaseCostSec =
      ctx.config.unmatchedBaseCostSec ??
      DEFAULT_MATCHING_CONFIG.unmatchedBaseCostSec ??
      ctx.config.maxPickupEtaSec;
    const speedMps = ctx.config.speedMps;
    const maxPickupEtaSec = ctx.config.maxPickupEtaSec;

    // Offset added so that real edge costs (pickupETA - idleBonus) are non-negative
    const offset = maxIdleBonusSec;

    const costMatrix: number[][] = Array.from({ length: R }, () => new Array<number>(M));

    for (let i = 0; i < R; i++) {
      const req = sortedRequests[i]!;
      const row = costMatrix[i]!;
      const waitSec = Math.max(0, (ctx.nowMs - req.requestedAtMs) / 1000);
      const waitPenalty = waitWeight * waitSec;
      const excluded = new Set(req.excludedDriverIds ?? []);

      for (let j = 0; j < D; j++) {
        const drv = sortedDrivers[j]!;
        if (excluded.has(drv.id)) {
          row[j] = INFEASIBLE_COST;
          continue;
        }

        const eta = pickupEtaSec(drv.location, req.pickup, speedMps);
        if (eta > maxPickupEtaSec) {
          row[j] = INFEASIBLE_COST;
          continue;
        }

        const idleSec = Math.max(0, (ctx.nowMs - drv.idleSinceMs) / 1000);
        const idleBonus = Math.min(maxIdleBonusSec, idleSec * idleWeight);
        row[j] = eta - idleBonus + offset;
      }

      for (let k = 0; k < R; k++) {
        if (k === i) {
          row[D + k] = unmatchedBaseCostSec + waitPenalty + offset;
        } else {
          row[D + k] = INFEASIBLE_COST;
        }
      }
    }

    const { rowToCol } = hungarian(costMatrix);
    const assignedRideIds = new Set<string>();
    const assignments: Assignment[] = [];

    for (let i = 0; i < R; i++) {
      const col = rowToCol[i]!;
      const req = sortedRequests[i]!;
      const row = costMatrix[i]!;
      const costVal = row[col]!;

      if (col < D && costVal < INFEASIBLE_COST / 2) {
        const drv = sortedDrivers[col]!;
        const eta = pickupEtaSec(drv.location, req.pickup, speedMps);
        const idleSec = Math.max(0, (ctx.nowMs - drv.idleSinceMs) / 1000);
        const idleBonus = Math.min(maxIdleBonusSec, idleSec * idleWeight);

        assignments.push({
          rideId: req.id,
          driverId: drv.id,
          pickupEtaSec: eta,
          cost: eta - idleBonus,
        });
        assignedRideIds.add(req.id);
      }
    }

    return {
      assignments,
      unmatchedRideIds: requests.filter((r) => !assignedRideIds.has(r.id)).map((r) => r.id),
    };
  }
}
