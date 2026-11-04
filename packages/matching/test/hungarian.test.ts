import { describe, it, expect } from 'vitest';
import { hungarian } from '../src/hungarian';

// Brute-force solver for testing correctness on small N x M (N <= M)
function bruteForceMinCost(costMatrix: number[][]): {
  minCost: number;
  bestAssignment: number[];
} {
  const n = costMatrix.length;
  if (n === 0) return { minCost: 0, bestAssignment: [] };
  const firstRow = costMatrix[0];
  if (!firstRow) return { minCost: 0, bestAssignment: [] };
  const m = firstRow.length;

  let minCost = Number.POSITIVE_INFINITY;
  let bestAssignment: number[] = [];

  const usedCols = new Array<boolean>(m).fill(false);
  const currentAssignment = new Array<number>(n);

  function backtrack(row: number, currentCost: number) {
    if (row === n) {
      if (currentCost < minCost) {
        minCost = currentCost;
        bestAssignment = [...currentAssignment];
      }
      return;
    }

    const rowCosts = costMatrix[row]!;
    for (let col = 0; col < m; col++) {
      if (!usedCols[col]) {
        usedCols[col] = true;
        currentAssignment[row] = col;
        backtrack(row + 1, currentCost + rowCosts[col]!);
        usedCols[col] = false;
      }
    }
  }

  backtrack(0, 0);
  return { minCost, bestAssignment };
}

// Simple seeded SplitMix32 PRNG for test reproducibility
function makeSeededPrng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s |= 0;
    s = (s + 0x9e3779b9) | 0;
    let t = Math.imul(s ^ (s >>> 16), 0x21f0aaad);
    t = Math.imul(t ^ (t >>> 15), 0x735a2d97);
    return ((t ^ (t >>> 15)) >>> 0) / 4294967296;
  };
}

describe('Hungarian Algorithm (Kuhn-Munkres)', () => {
  it('handles empty matrix', () => {
    const res = hungarian([]);
    expect(res.rowToCol).toEqual([]);
    expect(res.totalCost).toBe(0);
  });

  it('solves simple 1x1 matrix', () => {
    const res = hungarian([[42]]);
    expect(res.rowToCol).toEqual([0]);
    expect(res.totalCost).toBe(42);
  });

  it('solves rectangular 1x3 matrix', () => {
    const res = hungarian([[10, 5, 20]]);
    expect(res.rowToCol).toEqual([1]);
    expect(res.totalCost).toBe(5);
  });

  it('solves textbook 3x3 assignment problem', () => {
    // Classic example where greedy fails:
    // [ [1, 2, 3],
    //   [2, 4, 6],
    //   [3, 6, 9] ]
    const matrix = [
      [15, 40, 45],
      [20, 60, 35],
      [20, 40, 25],
    ];
    // Optimum: Row 0 -> Col 1 (40), Row 1 -> Col 0 (20), Row 2 -> Col 2 (25) => 85
    // or Row 0 -> Col 0 (15), Row 1 -> Col 1 (60), Row 2 -> Col 2 (25) => 100
    // Best: 40 + 20 + 25 = 85 or 15 + 35 + 40 = 90.
    const res = hungarian(matrix);
    const bf = bruteForceMinCost(matrix);
    expect(res.totalCost).toBe(bf.minCost);
    expect(res.totalCost).toBe(85); // (40 + 20 + 25)
  });

  it('solves rectangular 3x5 matrix', () => {
    const matrix = [
      [10, 5, 12, 15, 8],
      [4, 7, 10, 6, 9],
      [11, 14, 3, 8, 5],
    ];
    const res = hungarian(matrix);
    const bf = bruteForceMinCost(matrix);
    expect(res.totalCost).toBe(bf.minCost);
  });

  it('AC1: solver output cost equals brute-force optimum on randomised small instances (n <= 7)', () => {
    const rng = makeSeededPrng(42);
    let casesRun = 0;

    for (let n = 1; n <= 6; n++) {
      for (let extra = 0; extra <= 3; extra++) {
        const m = n + extra;
        for (let iter = 0; iter < 5; iter++) {
          const matrix: number[][] = [];
          for (let r = 0; r < n; r++) {
            const row: number[] = [];
            for (let c = 0; c < m; c++) {
              // Generate random integer costs between 1 and 100
              row.push(Math.floor(rng() * 100) + 1);
            }
            matrix.push(row);
          }

          const hungarianResult = hungarian(matrix);
          const bruteForceResult = bruteForceMinCost(matrix);

          expect(hungarianResult.totalCost).toBe(bruteForceResult.minCost);

          // Verify rowToCol is a valid permutation of distinct columns
          const used = new Set(hungarianResult.rowToCol);
          expect(used.size).toBe(n);

          casesRun++;
        }
      }
    }

    expect(casesRun).toBe(120);
  });
});
