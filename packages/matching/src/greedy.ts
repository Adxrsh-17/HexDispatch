import { pickupEtaSec } from './geo';
import type {
  Assignment,
  DriverCandidate,
  MatchContext,
  MatchResult,
  MatchingPolicy,
  RideRequest,
} from './types';

const byString = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Baseline policy (the control group). Serve requests in arrival order; each takes the
 * unclaimed, non-excluded driver with the lowest pickup ETA. Locally optimal, globally
 * poor: an early rider can take the driver a later rider needed more.
 * Ties break by driver id so output is deterministic.
 */
export class GreedyPolicy implements MatchingPolicy {
  readonly name = 'greedy';

  match(
    requests: readonly RideRequest[],
    drivers: readonly DriverCandidate[],
    ctx: MatchContext,
  ): MatchResult {
    const ordered = [...requests].sort(
      (a, b) => a.requestedAtMs - b.requestedAtMs || byString(a.id, b.id),
    );
    const taken = new Set<string>();
    const assignmentByRide = new Map<string, Assignment>();

    for (const ride of ordered) {
      const excluded = new Set(ride.excludedDriverIds ?? []);
      let best: { driverId: string; eta: number } | undefined;

      for (const driver of drivers) {
        if (taken.has(driver.id) || excluded.has(driver.id)) continue;
        const eta = pickupEtaSec(driver.location, ride.pickup, ctx.config.speedMps);
        if (eta > ctx.config.maxPickupEtaSec) continue;
        if (!best || eta < best.eta || (eta === best.eta && driver.id < best.driverId)) {
          best = { driverId: driver.id, eta };
        }
      }

      if (best) {
        taken.add(best.driverId);
        assignmentByRide.set(ride.id, {
          rideId: ride.id,
          driverId: best.driverId,
          pickupEtaSec: best.eta,
          cost: best.eta,
        });
      }
    }

    return {
      assignments: [...assignmentByRide.values()],
      unmatchedRideIds: requests.filter((r) => !assignmentByRide.has(r.id)).map((r) => r.id),
    };
  }
}
