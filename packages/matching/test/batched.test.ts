import { describe, it, expect } from 'vitest';
import { BatchedPolicy } from '../src/batched';
import { GreedyPolicy } from '../src/greedy';
import { DEFAULT_MATCHING_CONFIG, type DriverCandidate, type RideRequest } from '../src/types';

describe('BatchedPolicy', () => {
  const policy = new BatchedPolicy();
  const baseCtx = {
    nowMs: 1_700_000_000_000,
    config: DEFAULT_MATCHING_CONFIG,
  };

  it('returns empty when no requests or no drivers', () => {
    const res1 = policy.match([], [], baseCtx);
    expect(res1.assignments).toEqual([]);
    expect(res1.unmatchedRideIds).toEqual([]);

    const res2 = policy.match(
      [
        {
          id: 'r1',
          pickup: { lat: 12.9716, lng: 77.5946 },
          requestedAtMs: baseCtx.nowMs,
        },
      ],
      [],
      baseCtx,
    );
    expect(res2.assignments).toEqual([]);
    expect(res2.unmatchedRideIds).toEqual(['r1']);
  });

  it('outperforms greedy when greedy makes a globally suboptimal assignment', () => {
    // Scenario:
    // Ride 1 (requested 10s earlier) is near Driver A (dist 100m) and Driver B (dist 150m)
    // Ride 2 (requested now) is near Driver A (dist 200m) but Driver B is far (dist 2000m)
    //
    // Greedy serves Ride 1 first -> gives Driver A (100m) to Ride 1.
    // Ride 2 has to take Driver B (2000m) or is left unmatched. Total distance = 2100m.
    //
    // Batched pairs Ride 1 with Driver B (150m) and Ride 2 with Driver A (200m).
    // Total distance = 350m! (Vastly lower total pickup ETA)

    const ride1: RideRequest = {
      id: 'r1',
      pickup: { lat: 12.9716, lng: 77.5946 }, // (0, 0)
      requestedAtMs: baseCtx.nowMs - 10_000,
    };
    const ride2: RideRequest = {
      id: 'r2',
      pickup: { lat: 12.973, lng: 77.5946 }, // near A, far from B
      requestedAtMs: baseCtx.nowMs,
    };

    const driverA: DriverCandidate = {
      id: 'dA',
      location: { lat: 12.972, lng: 77.5946 }, // between r1 and r2
      idleSinceMs: baseCtx.nowMs - 60_000,
    };
    const driverB: DriverCandidate = {
      id: 'dB',
      location: { lat: 12.9705, lng: 77.5946 }, // south of r1, far from r2
      idleSinceMs: baseCtx.nowMs - 60_000,
    };

    const greedy = new GreedyPolicy();
    const greedyRes = greedy.match([ride1, ride2], [driverA, driverB], baseCtx);
    const batchedRes = policy.match([ride1, ride2], [driverA, driverB], baseCtx);

    const greedyTotalEta = greedyRes.assignments.reduce((sum, a) => sum + a.pickupEtaSec, 0);
    const batchedTotalEta = batchedRes.assignments.reduce((sum, a) => sum + a.pickupEtaSec, 0);

    // Greedy gives dA to r1 and dB to r2
    expect(greedyRes.assignments.find((a) => a.rideId === 'r1')?.driverId).toBe('dA');
    expect(greedyRes.assignments.find((a) => a.rideId === 'r2')?.driverId).toBe('dB');

    // Batched gives dB to r1 and dA to r2, minimizing total ETA!
    expect(batchedRes.assignments.find((a) => a.rideId === 'r1')?.driverId).toBe('dB');
    expect(batchedRes.assignments.find((a) => a.rideId === 'r2')?.driverId).toBe('dA');

    expect(batchedTotalEta).toBeLessThan(greedyTotalEta);
  });

  it('aging: prioritizes an older rider over a newer rider when only one driver is available', () => {
    // Both riders at identical pickup point
    const rOld: RideRequest = {
      id: 'r-old',
      pickup: { lat: 12.9716, lng: 77.5946 },
      requestedAtMs: baseCtx.nowMs - 30_000, // waited 30s
    };
    const rNew: RideRequest = {
      id: 'r-new',
      pickup: { lat: 12.9716, lng: 77.5946 },
      requestedAtMs: baseCtx.nowMs - 1_000, // waited 1s
    };

    const driver: DriverCandidate = {
      id: 'd1',
      location: { lat: 12.972, lng: 77.5946 },
      idleSinceMs: baseCtx.nowMs - 10_000,
    };

    const res = policy.match([rNew, rOld], [driver], baseCtx);
    expect(res.assignments).toHaveLength(1);
    expect(res.assignments[0]?.rideId).toBe('r-old');
    expect(res.unmatchedRideIds).toEqual(['r-new']);
  });

  it('idle bonus: prioritizes a driver who has been idle longer when equidistant', () => {
    const ride: RideRequest = {
      id: 'r1',
      pickup: { lat: 12.9716, lng: 77.5946 },
      requestedAtMs: baseCtx.nowMs - 5_000,
    };

    const dIdleLong: DriverCandidate = {
      id: 'd-idle-long',
      location: { lat: 12.972, lng: 77.5946 },
      idleSinceMs: baseCtx.nowMs - 300_000, // idle for 5 mins
    };
    const dIdleShort: DriverCandidate = {
      id: 'd-idle-short',
      location: { lat: 12.972, lng: 77.5946 }, // identical location
      idleSinceMs: baseCtx.nowMs - 10_000, // idle for 10s
    };

    const res = policy.match([ride], [dIdleShort, dIdleLong], baseCtx);
    expect(res.assignments).toHaveLength(1);
    expect(res.assignments[0]?.driverId).toBe('d-idle-long');
  });

  it('excludes drivers who are in excludedDriverIds or exceed maxPickupEtaSec', () => {
    const ride: RideRequest = {
      id: 'r1',
      pickup: { lat: 12.9716, lng: 77.5946 },
      requestedAtMs: baseCtx.nowMs,
      excludedDriverIds: ['d-excluded'],
    };

    const dExcluded: DriverCandidate = {
      id: 'd-excluded',
      location: { lat: 12.9717, lng: 77.5946 },
      idleSinceMs: baseCtx.nowMs,
    };
    const dFar: DriverCandidate = {
      id: 'd-far',
      location: { lat: 13.5, lng: 77.5946 }, // > 50 km away
      idleSinceMs: baseCtx.nowMs,
    };

    const res = policy.match([ride], [dExcluded, dFar], baseCtx);
    expect(res.assignments).toHaveLength(0);
    expect(res.unmatchedRideIds).toEqual(['r1']);
  });

  it('falls back to greedy when problem size exceeds batchMaxCells', () => {
    const customCtx = {
      ...baseCtx,
      config: {
        ...baseCtx.config,
        batchMaxCells: 4, // Very small threshold
      },
    };

    // 3 requests * 2 drivers = 6 cells > 4
    const reqs: RideRequest[] = [
      { id: 'r1', pickup: { lat: 12.97, lng: 77.59 }, requestedAtMs: baseCtx.nowMs - 2000 },
      { id: 'r2', pickup: { lat: 12.97, lng: 77.59 }, requestedAtMs: baseCtx.nowMs - 1000 },
      { id: 'r3', pickup: { lat: 12.97, lng: 77.59 }, requestedAtMs: baseCtx.nowMs },
    ];
    const drvs: DriverCandidate[] = [
      { id: 'd1', location: { lat: 12.971, lng: 77.59 }, idleSinceMs: baseCtx.nowMs },
      { id: 'd2', location: { lat: 12.972, lng: 77.59 }, idleSinceMs: baseCtx.nowMs },
    ];

    const res = policy.match(reqs, drvs, customCtx);
    expect(res.assignments).toHaveLength(2);
    expect(res.unmatchedRideIds).toEqual(['r3']);
  });

  it('AC4: measures matching latency (p50/p95) for representative batch sizes', () => {
    const runs = 20;
    const latencies: number[] = [];

    // Representative batch size: 50 riders x 50 drivers
    const R = 50;
    const D = 50;

    for (let run = 0; run < runs; run++) {
      const reqs: RideRequest[] = Array.from({ length: R }, (_, i) => ({
        id: `r-${i}`,
        pickup: {
          lat: 12.9716 + (i * 0.001 - 0.025),
          lng: 77.5946 + ((i % 5) * 0.001 - 0.002),
        },
        requestedAtMs: baseCtx.nowMs - i * 1000,
      }));

      const drvs: DriverCandidate[] = Array.from({ length: D }, (_, j) => ({
        id: `d-${j}`,
        location: {
          lat: 12.9716 + (j * 0.001 - 0.025),
          lng: 77.5946 + ((j % 7) * 0.001 - 0.003),
        },
        idleSinceMs: baseCtx.nowMs - j * 2000,
      }));

      const start = performance.now();
      policy.match(reqs, drvs, baseCtx);
      const elapsedMs = performance.now() - start;
      latencies.push(elapsedMs);
    }

    latencies.sort((a, b) => a - b);
    const p50 = latencies[Math.floor(runs * 0.5)] ?? 0;
    const p95 = latencies[Math.floor(runs * 0.95)] ?? 0;

    console.log(
      `[AC4 Benchmark] 50x50 batch matching latency: p50 = ${p50.toFixed(2)}ms, p95 = ${p95.toFixed(2)}ms`,
    );

    // Must be well within the 2000ms window (typically < 10ms)
    expect(p50).toBeLessThan(50);
    expect(p95).toBeLessThan(100);
  });
});
