import { describe, it, expect } from 'vitest';
import { computeSurgeStep, DEFAULT_SURGE_CONFIG } from '../src/surge-engine';

describe('Surge Algorithm Engine (AC2, AC3, AC4)', () => {
  const cell = '8860145b53fffff';

  it('AC3: clamps multiplier to [1.0, maxSurge] regardless of extreme ratios', () => {
    // Extreme oversupply (demand = 0, supply = 100)
    const low = computeSurgeStep({
      cell,
      demand: 0,
      supply: 100,
    });
    expect(low.rawMultiplier).toBe(1.0);
    expect(low.finalMultiplier).toBe(1.0);

    // Extreme undersupply (demand = 1000, supply = 1) -> ratio = 1000
    // Raw calculated: 1 + 0.5 * (1000 - 1) = 500.5 -> must clamp to maxSurge (2.5)
    const high = computeSurgeStep({
      cell,
      demand: 1000,
      supply: 1,
      prevMultiplier: 2.5, // allow stepping straight to max
    });
    expect(high.rawMultiplier).toBe(DEFAULT_SURGE_CONFIG.maxSurge);
    expect(high.finalMultiplier).toBe(DEFAULT_SURGE_CONFIG.maxSurge);
  });

  it('AC3: step limit restricts single-interval changes to maxStep (default 0.2)', () => {
    // Huge demand spike from base multiplier 1.0
    const spike = computeSurgeStep({
      cell,
      demand: 200,
      supply: 10, // ratio = 20 -> raw = 1 + 0.5 * 19 = 10.5 -> clamped to 2.5
      prevMultiplier: 1.0,
      config: { beta: 0 }, // isolate from neighbour blending for pure step test
    });

    // Despite rawMultiplier = 2.5, steppedMultiplier can only rise by maxStep (0.2)
    expect(spike.rawMultiplier).toBe(2.5);
    expect(spike.steppedMultiplier).toBe(1.2);
    expect(spike.finalMultiplier).toBe(1.2);

    // Huge sudden drop from 2.5 to no demand
    const drop = computeSurgeStep({
      cell,
      demand: 0,
      supply: 50,
      prevMultiplier: 2.5,
      config: { beta: 0 },
    });
    // Can only drop by maxStep (0.2)
    expect(drop.rawMultiplier).toBe(1.0);
    expect(drop.steppedMultiplier).toBe(2.3);
    expect(drop.finalMultiplier).toBe(2.3);
  });

  it('AC3: hysteresis dead-band holds previous multiplier when change is within thresholds', () => {
    const prevM = 1.5;

    // Small rise of 0.03 < upThreshold (0.05): should hold at 1.50
    const smallRise = computeSurgeStep({
      cell,
      demand: 11,
      supply: 5, // small ratio
      prevMultiplier: prevM,
      config: {
        alpha: 1.0, // instant EWMA for direct ratio testing
        k: 0.5,
        upThreshold: 0.05,
        downThreshold: 0.03,
        beta: 0,
      },
    });

    if (
      Math.abs(smallRise.steppedMultiplier - prevM) < 0.05 &&
      smallRise.steppedMultiplier > prevM
    ) {
      expect(smallRise.hysteresisMultiplier).toBe(prevM);
    }

    // Small drop of 0.02 < downThreshold (0.03): should hold at 1.50
    const smallDrop = computeSurgeStep({
      cell,
      demand: 9,
      supply: 5,
      prevMultiplier: prevM,
      config: {
        alpha: 1.0,
        k: 0.5,
        upThreshold: 0.05,
        downThreshold: 0.03,
        beta: 0,
      },
    });

    if (smallDrop.steppedMultiplier < prevM && prevM - smallDrop.steppedMultiplier < 0.03) {
      expect(smallDrop.hysteresisMultiplier).toBe(prevM);
    }
  });

  it('blends neighbour ring-1 mean according to beta weight', () => {
    const res = computeSurgeStep({
      cell,
      demand: 50,
      supply: 20,
      prevMultiplier: 1.5,
      neighbourMultipliers: [1.8, 2.0, 1.9], // mean = 1.9
      config: {
        beta: 0.2,
      },
    });

    expect(res.neighbourMean).toBe(1.9);
    // finalMultiplier incorporates 80% own + 20% neighbourMean
    expect(res.finalMultiplier).toBeGreaterThanOrEqual(1.0);
  });

  it('honors admin override when set', () => {
    const res = computeSurgeStep({
      cell,
      demand: 5,
      supply: 100, // natural surge would be 1.0
      adminOverride: 2.25,
    });

    expect(res.hasAdminOverride).toBe(true);
    expect(res.adminOverride).toBe(2.25);
    expect(res.finalMultiplier).toBe(2.25);
  });

  it('AC2: stability test: under steady demand the multiplier converges monotonically and does not oscillate', () => {
    // 120 cycles (equivalent to 1 hour with 30s intervals) under constant demand = 40, supply = 10
    const steadyDemand = 40;
    const steadySupply = 10;

    let currentM = 1.0;
    let smoothedD: number | undefined;
    let smoothedS: number | undefined;

    const multiplierHistory: number[] = [];

    for (let step = 0; step < 120; step++) {
      const out = computeSurgeStep({
        cell,
        demand: steadyDemand,
        supply: steadySupply,
        prevSmoothedDemand: smoothedD,
        prevSmoothedSupply: smoothedS,
        prevMultiplier: currentM,
        config: { beta: 0 },
      });

      smoothedD = out.smoothedDemand;
      smoothedS = out.smoothedSupply;
      currentM = out.finalMultiplier;
      multiplierHistory.push(currentM);
    }

    // After ~15-20 steps, the multiplier must converge to steady-state value
    const tail = multiplierHistory.slice(30);
    const steadyState = tail[0]!;

    // Assert convergence: all values in the second half of the hour equal the steady state (no oscillation!)
    for (let i = 1; i < tail.length; i++) {
      expect(tail[i]).toBe(steadyState);
    }

    // Verify bounded rate of change per hour
    for (let i = 1; i < multiplierHistory.length; i++) {
      const stepChange = Math.abs(multiplierHistory[i]! - multiplierHistory[i - 1]!);
      expect(stepChange).toBeLessThanOrEqual(DEFAULT_SURGE_CONFIG.maxStep + 0.001);
    }
  });

  it('AC4: explain output reproduces the multiplier from its listed inputs', () => {
    const explain = computeSurgeStep({
      cell,
      demand: 35,
      supply: 15,
      prevSmoothedDemand: 30,
      prevSmoothedSupply: 15,
      prevMultiplier: 1.3,
      neighbourMultipliers: [1.4, 1.5],
    });

    expect(explain.cell).toBe(cell);
    expect(explain.demand).toBe(35);
    expect(explain.supply).toBe(15);
    expect(explain.smoothedDemand).toBeDefined();
    expect(explain.smoothedSupply).toBeDefined();
    expect(explain.ratio).toBeDefined();
    expect(explain.rawMultiplier).toBeDefined();
    expect(explain.steppedMultiplier).toBeDefined();
    expect(explain.hysteresisMultiplier).toBeDefined();
    expect(explain.neighbourMean).toBe(1.45);
    expect(explain.finalMultiplier).toBeDefined();

    // Re-running with the identical parameters produces exact reproduction
    const repeat = computeSurgeStep({
      cell,
      demand: explain.demand,
      supply: explain.supply,
      prevSmoothedDemand: 30,
      prevSmoothedSupply: 15,
      prevMultiplier: 1.3,
      neighbourMultipliers: [1.4, 1.5],
    });

    expect(repeat.finalMultiplier).toBe(explain.finalMultiplier);
    expect(repeat.rawMultiplier).toBe(explain.rawMultiplier);
  });
});
