/**
 * Rectangular Hungarian (Kuhn-Munkres) Algorithm for Minimum Weight Bipartite Matching.
 *
 * Given an N x M cost matrix with N <= M, finds an injection f: {0..N-1} -> {0..M-1}
 * that minimizes the total cost sum_{i=0}^{N-1} costMatrix[i][f(i)].
 *
 * Complexity: O(N * M^2) time, O(N + M) space.
 * Pure TypeScript, zero external dependencies.
 */

export interface HungarianResult {
  /** Array of length N where rowToCol[i] is the assigned column index for row i. */
  rowToCol: number[];
  /** Total sum of costs for the selected assignments. */
  totalCost: number;
}

export function hungarian(costMatrix: readonly (readonly number[])[]): HungarianResult {
  const n = costMatrix.length;
  if (n === 0) {
    return { rowToCol: [], totalCost: 0 };
  }
  const firstRow = costMatrix[0];
  if (!firstRow) {
    return { rowToCol: [], totalCost: 0 };
  }
  const m = firstRow.length;
  if (n > m) {
    throw new Error(`Hungarian algorithm requires rows (N=${n}) <= columns (M=${m})`);
  }

  // 1-based indexing for internal dual potential calculations:
  // u has size n + 1, v has size m + 1
  // p has size m + 1 (stores which row 1..n is matched to column 1..m)
  // way has size m + 1 (predecessor in augmenting path)
  const u = new Float64Array(n + 1);
  const v = new Float64Array(m + 1);
  const p = new Int32Array(m + 1);
  const way = new Int32Array(m + 1);
  const minv = new Float64Array(m + 1);
  const used = new Uint8Array(m + 1);

  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    minv.fill(Number.POSITIVE_INFINITY);
    used.fill(0);

    do {
      used[j0] = 1;
      const i0 = p[j0]!;
      let delta = Number.POSITIVE_INFINITY;
      let j1 = 0;

      const matrixRow = costMatrix[i0 - 1]!;
      const u_i0 = u[i0]!;

      for (let j = 1; j <= m; j++) {
        if (!used[j]) {
          const costVal = matrixRow[j - 1]!;
          const v_j = v[j]!;
          const cur = costVal - u_i0 - v_j;
          if (cur < minv[j]!) {
            minv[j] = cur;
            way[j] = j0;
          }
          if (minv[j]! < delta) {
            delta = minv[j]!;
            j1 = j;
          }
        }
      }

      for (let j = 0; j <= m; j++) {
        if (used[j]) {
          const p_j = p[j]!;
          u[p_j] = u[p_j]! + delta;
          v[j] = v[j]! - delta;
        } else {
          minv[j] = minv[j]! - delta;
        }
      }

      j0 = j1;
    } while (p[j0] !== 0);

    do {
      const j1 = way[j0]!;
      p[j0] = p[j1]!;
      j0 = j1;
    } while (j0 !== 0);
  }

  const rowToCol = new Array<number>(n);
  let totalCost = 0;
  for (let j = 1; j <= m; j++) {
    const p_j = p[j]!;
    if (p_j !== 0) {
      const rowIdx = p_j - 1;
      rowToCol[rowIdx] = j - 1;
      const row = costMatrix[rowIdx]!;
      totalCost += row[j - 1]!;
    }
  }

  return { rowToCol, totalCost };
}
