import { describe, it, expect, vi } from 'vitest';
import { TrustEngine } from '../src/trust/trust-engine';

describe('TrustEngine (Phase 8 Task 1 & 2)', () => {
  it('does not flag normal driving pings', async () => {
    const engine = new TrustEngine();
    const driverId = '11111111-1111-1111-1111-111111111111';

    // Start at Bangalore center
    const ping1 = {
      lat: 12.9716,
      lng: 77.5946,
      status: 'AVAILABLE' as const,
      timestampMs: 1000000,
    };
    const res1 = await engine.evaluateLocationPing(driverId, ping1);
    expect(res1.isAnomaly).toBe(false);

    // 10 seconds later, moved 150m (~15 m/s or 54 km/h)
    const ping2 = {
      lat: 12.9729,
      lng: 77.5946,
      status: 'AVAILABLE' as const,
      timestampMs: 1000000 + 10_000,
    };
    const res2 = await engine.evaluateLocationPing(driverId, ping2);
    expect(res2.isAnomaly).toBe(false);
    expect(engine.getAllFlags()).toHaveLength(0);
  });

  it('flags impossible speed anomaly (> 42 m/s)', async () => {
    const publishedEvents: Array<{ topic: string; key: string; payload: unknown }> = [];
    const mockProducer = {
      publish: vi.fn(async (topic: string, key: string, payload: unknown) => {
        publishedEvents.push({ topic, key, payload });
      }),
    };

    const engine = new TrustEngine({
      maxSpeedMps: 42,
      producer: mockProducer,
    });
    const driverId = '22222222-2222-2222-2222-222222222222';

    // Ping 1
    await engine.evaluateLocationPing(driverId, {
      lat: 12.9716,
      lng: 77.5946,
      status: 'AVAILABLE',
      timestampMs: 1000000,
    });

    // Ping 2: 10 seconds later, moved ~800m (80 m/s or 288 km/h)
    const res = await engine.evaluateLocationPing(driverId, {
      lat: 12.9788,
      lng: 77.5946,
      status: 'AVAILABLE',
      timestampMs: 1000000 + 10_000,
    });

    expect(res.isAnomaly).toBe(true);
    expect(res.flag?.reason).toBe('IMPOSSIBLE_SPEED');
    expect(res.flag?.riskScore).toBeGreaterThanOrEqual(50);
    expect(mockProducer.publish).toHaveBeenCalledTimes(1);
    expect(publishedEvents[0]?.topic).toBe('trust.flagged');
  });

  it('flags teleport jumps (> 2000m jump in seconds)', async () => {
    const engine = new TrustEngine();
    const driverId = '33333333-3333-3333-3333-333333333333';

    await engine.evaluateLocationPing(driverId, {
      lat: 12.9716,
      lng: 77.5946,
      status: 'AVAILABLE',
      timestampMs: 1000000,
    });

    // 5 seconds later, jump 5km
    const res = await engine.evaluateLocationPing(driverId, {
      lat: 13.0166,
      lng: 77.5946,
      status: 'AVAILABLE',
      timestampMs: 1000000 + 5_000,
    });

    expect(res.isAnomaly).toBe(true);
    expect(res.flag?.reason).toBe('TELEPORT_JUMP');
  });

  it('flags frozen GPS during ON_TRIP status (duration >= 300s)', async () => {
    const engine = new TrustEngine({ frozenGpsThresholdSec: 300 });
    const driverId = '44444444-4444-4444-4444-444444444444';

    // Ping at start of trip
    await engine.evaluateLocationPing(driverId, {
      lat: 12.9716,
      lng: 77.5946,
      status: 'ON_TRIP',
      timestampMs: 1000000,
    });

    // Ping 100 seconds later, exact same spot (not yet 300s)
    const midRes = await engine.evaluateLocationPing(driverId, {
      lat: 12.9716,
      lng: 77.5946,
      status: 'ON_TRIP',
      timestampMs: 1000000 + 100_000,
    });
    expect(midRes.isAnomaly).toBe(false);

    // Ping 305 seconds later, still exact same spot
    const endRes = await engine.evaluateLocationPing(driverId, {
      lat: 12.9716,
      lng: 77.5946,
      status: 'ON_TRIP',
      timestampMs: 1000000 + 305_000,
    });
    expect(endRes.isAnomaly).toBe(true);
    expect(endRes.flag?.reason).toBe('FROZEN_GPS');
  });

  it('flags cancellation abuse for riders and drivers (>= 4 cancellations and >= 60% rate)', async () => {
    const engine = new TrustEngine({
      cancellationThresholdCount: 4,
      cancellationWindowSec: 3600,
    });
    const riderId = '55555555-5555-5555-5555-555555555555';
    const baseTime = 1700000000000;

    // 1st cancellation
    let res = await engine.recordRideOutcome({
      subjectId: riderId,
      subjectType: 'RIDER',
      isCancelled: true,
      timestampMs: baseTime,
    });
    expect(res.isAbuser).toBe(false);

    // 2nd cancellation
    res = await engine.recordRideOutcome({
      subjectId: riderId,
      subjectType: 'RIDER',
      isCancelled: true,
      timestampMs: baseTime + 60_000,
    });
    expect(res.isAbuser).toBe(false);

    // 3rd cancellation
    res = await engine.recordRideOutcome({
      subjectId: riderId,
      subjectType: 'RIDER',
      isCancelled: true,
      timestampMs: baseTime + 120_000,
    });
    expect(res.isAbuser).toBe(false);

    // 4th cancellation -> triggers abuse flag
    res = await engine.recordRideOutcome({
      subjectId: riderId,
      subjectType: 'RIDER',
      isCancelled: true,
      timestampMs: baseTime + 180_000,
    });
    expect(res.isAbuser).toBe(true);
    expect(res.flag?.reason).toBe('CANCELLATION_ABUSE');
    expect(res.flag?.details.cancelCount).toBe(4);
    expect(res.flag?.details.cancelRate).toBe(100);

    expect(engine.getAllFlags()).toHaveLength(1);
  });
});
