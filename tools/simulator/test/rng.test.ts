import { describe, it, expect } from 'vitest';
import { SeededRng } from '../src/rng/seeded-rng';
import { RngManager } from '../src/rng/rng-manager';

describe('Seeded PRNG & Sub-stream Isolation (Task 1)', () => {
  it('produces identical sequences given identical seeds', () => {
    const rng1 = new SeededRng(1337);
    const rng2 = new SeededRng(1337);

    const seq1 = Array.from({ length: 50 }, () => rng1.next());
    const seq2 = Array.from({ length: 50 }, () => rng2.next());

    expect(seq1).toEqual(seq2);
  });

  it('produces different sequences given different seeds', () => {
    const rng1 = new SeededRng(1337);
    const rng2 = new SeededRng(9999);

    const val1 = rng1.next();
    const val2 = rng2.next();

    expect(val1).not.toBe(val2);
  });

  it('generates uniform numbers, integers, and normals within expected boundaries', () => {
    const rng = new SeededRng(42);

    for (let i = 0; i < 100; i++) {
      const u = rng.next();
      expect(u).toBeGreaterThanOrEqual(0);
      expect(u).toBeLessThan(1);

      const int = rng.nextInt(5, 15);
      expect(int).toBeGreaterThanOrEqual(5);
      expect(int).toBeLessThanOrEqual(15);
      expect(Number.isInteger(int)).toBe(true);

      const f = rng.nextFloat(2.5, 7.5);
      expect(f).toBeGreaterThanOrEqual(2.5);
      expect(f).toBeLessThan(7.5);

      const exp = rng.nextExponential(0.5);
      expect(exp).toBeGreaterThan(0);
    }
  });

  it('guarantees sub-stream isolation so consumption in demand does not shift driver or acceptance streams', () => {
    const mgr1 = new RngManager(42);
    const mgr2 = new RngManager(42);

    // Consume 100 numbers from mgr1.demand
    for (let i = 0; i < 100; i++) {
      mgr1.demand.next();
    }
    // Do not touch mgr2.demand

    // Driver and acceptance sub-streams MUST remain 100% byte-identical
    const driverSeq1 = Array.from({ length: 25 }, () => mgr1.driver.next());
    const driverSeq2 = Array.from({ length: 25 }, () => mgr2.driver.next());
    expect(driverSeq1).toEqual(driverSeq2);

    const acceptSeq1 = Array.from({ length: 25 }, () => mgr1.acceptance.next());
    const acceptSeq2 = Array.from({ length: 25 }, () => mgr2.acceptance.next());
    expect(acceptSeq1).toEqual(acceptSeq2);
  });
});
