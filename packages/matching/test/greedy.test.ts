import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MATCHING_CONFIG,
  GreedyPolicy,
  haversineMeters,
  type DriverCandidate,
  type MatchContext,
  type RideRequest,
} from '../src';

const ctx: MatchContext = { nowMs: 1_000_000, config: DEFAULT_MATCHING_CONFIG };
const policy = new GreedyPolicy();

// Points on the equator: 0.001 degrees of longitude is roughly 111 m.
const at = (lngDeg: number) => ({ lat: 0, lng: lngDeg });
const driver = (id: string, lngDeg: number): DriverCandidate => ({
  id,
  location: at(lngDeg),
  idleSinceMs: 0,
});
const ride = (
  id: string,
  lngDeg: number,
  requestedAtMs = 0,
  excluded: string[] = [],
): RideRequest => ({
  id,
  pickup: at(lngDeg),
  requestedAtMs,
  excludedDriverIds: excluded,
});

describe('haversineMeters', () => {
  it('is zero for identical points', () => {
    expect(haversineMeters(at(0), at(0))).toBe(0);
  });
  it('matches ~111.19 km per degree on the equator', () => {
    expect(haversineMeters(at(0), at(1))).toBeGreaterThan(111_000);
    expect(haversineMeters(at(0), at(1))).toBeLessThan(111_400);
  });
  it('is symmetric', () => {
    const a = { lat: 12.97, lng: 77.59 };
    const b = { lat: 13.08, lng: 77.64 };
    expect(haversineMeters(a, b)).toBeCloseTo(haversineMeters(b, a), 6);
  });
});

describe('GreedyPolicy', () => {
  it('assigns the nearest driver', () => {
    const res = policy.match([ride('r1', 0)], [driver('far', 0.02), driver('near', 0.005)], ctx);
    expect(res.assignments).toHaveLength(1);
    expect(res.assignments[0]).toMatchObject({ rideId: 'r1', driverId: 'near' });
    expect(res.unmatchedRideIds).toEqual([]);
  });

  it('never assigns a driver twice', () => {
    const res = policy.match(
      [ride('r1', 0, 1), ride('r2', 0.001, 2), ride('r3', 0.002, 3)],
      [driver('d1', 0), driver('d2', 0.01)],
      ctx,
    );
    const driverIds = res.assignments.map((a) => a.driverId);
    expect(new Set(driverIds).size).toBe(driverIds.length);
    expect(res.assignments).toHaveLength(2);
    expect(res.unmatchedRideIds).toEqual(['r3']);
  });

  it('serves requests in arrival order, not input order', () => {
    const res = policy.match(
      [ride('late', 0, 200), ride('early', 0, 100)],
      [driver('only', 0.001)],
      ctx,
    );
    expect(res.assignments.map((a) => a.rideId)).toEqual(['early']);
    expect(res.unmatchedRideIds).toEqual(['late']);
  });

  it('skips drivers excluded for that ride', () => {
    const res = policy.match(
      [ride('r1', 0, 0, ['near'])],
      [driver('near', 0.001), driver('far', 0.02)],
      ctx,
    );
    expect(res.assignments[0]?.driverId).toBe('far');
  });

  it('leaves a ride unmatched when every driver is beyond max pickup ETA', () => {
    // 600 s * 8.33 m/s ~= 5 km ~= 0.045 degrees. 0.1 degrees is ~11 km.
    const res = policy.match([ride('r1', 0)], [driver('distant', 0.1)], ctx);
    expect(res.assignments).toEqual([]);
    expect(res.unmatchedRideIds).toEqual(['r1']);
  });

  it('is deterministic and breaks ties by driver id', () => {
    const drivers = [driver('b', 0.001), driver('a', -0.001)];
    const first = policy.match([ride('r1', 0)], drivers, ctx);
    const second = policy.match([ride('r1', 0)], [...drivers].reverse(), ctx);
    expect(first).toEqual(second);
    expect(first.assignments[0]?.driverId).toBe('a');
  });

  it('shows the greedy weakness the batched engine must fix', () => {
    // r1 arrives first and is closest to d1 (0.004 vs 0.006 deg) so it takes d1.
    // r2 sits right on d1 and is left with the far driver d2 (0.010 deg).
    // Optimal pairing is r1->d2 and r2->d1: total 0.006 deg vs greedy's 0.014 deg.
    const res = policy.match(
      [ride('r1', 0.004, 1), ride('r2', 0, 2)],
      [driver('d1', 0), driver('d2', 0.01)],
      ctx,
    );
    const byRide = Object.fromEntries(res.assignments.map((a) => [a.rideId, a.driverId]));
    expect(byRide).toEqual({ r1: 'd1', r2: 'd2' });
  });

  it('handles empty inputs', () => {
    expect(policy.match([], [], ctx)).toEqual({ assignments: [], unmatchedRideIds: [] });
    expect(policy.match([ride('r1', 0)], [], ctx).unmatchedRideIds).toEqual(['r1']);
  });
});
