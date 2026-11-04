import { describe, it, expect } from 'vitest';
import { calculateGini, calculateP90P10Ratio } from '../src/metrics/collector';

describe('Metrics & Fairness Calculations (Task 8)', () => {
  describe('calculateGini', () => {
    it('returns 0 for perfect equality (all equal earnings)', () => {
      const equalEarnings = [1000, 1000, 1000, 1000];
      const gini = calculateGini(equalEarnings);
      expect(gini).toBeCloseTo(0, 4);
    });

    it('returns near 1 for extreme inequality (one driver has all earnings)', () => {
      const extremeInequality = [0, 0, 0, 0, 0, 0, 0, 0, 0, 10000];
      const gini = calculateGini(extremeInequality);
      expect(gini).toBeGreaterThan(0.85);
    });

    it('returns 0 for empty or single element array', () => {
      expect(calculateGini([])).toBe(0);
      expect(calculateGini([500])).toBe(0);
      expect(calculateGini([0, 0, 0])).toBe(0);
    });
  });

  describe('calculateP90P10Ratio', () => {
    it('computes 90th / 10th percentile ratio', () => {
      // 10 items from 100 to 1000
      const earnings = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000];
      // p10 is index 1 = 200, p90 is index 9 = 1000 -> 1000 / 200 = 5.0
      const ratio = calculateP90P10Ratio(earnings);
      expect(ratio).toBe(5.0);
    });
  });
});
