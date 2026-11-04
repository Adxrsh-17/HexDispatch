# ADR 0006: Batched Matching using Rectangular Hungarian Algorithm

- Status: Accepted
- Date: 2026-11-04

## Context

In baseline dispatch (Phase 3), incoming ride requests were matched greedily in arrival order to the nearest available driver (`GreedyPolicy`). While simple and locally optimal for the earliest rider, greedy matching suffers from severe global inefficiencies:

1. An early rider can grab a driver who was uniquely close to a subsequent rider, leaving the second rider stranded or with a high ETA.
2. In dense urban peaks, high demand causes high contention and "nearest driver" myopia, resulting in elevated `NO_DRIVER_FOUND` rates.
3. Driver earnings diverge widely when nearest-distance alone dictates offers.

We need a batched matching algorithm that pools demand over a small window ($W = 2\text{ s}$), builds a global cost matrix, and finds a minimum-cost bipartite assignment.

## Alternatives Considered

1. **Min-Cost Max-Flow (MCMF) / Successive Shortest Path (SSP):**
   - _Pros:_ Flexible for capacity constraints and multi-passenger pooling.
   - _Cons:_ Overhead of graph construction and edge structures; for 1-to-1 ride matching, Hungarian / Kuhn-Munkres is substantially simpler, faster, and has zero external dependencies.
2. **Hungarian Algorithm (Kuhn-Munkres / Jonker-Volgenant 1D Augmenting Path):**
   - _Pros:_ Canonical $O(N \cdot M^2)$ minimum-weight bipartite matching; mathematically optimal; easily extended to rectangular matrices ($N \le M$) with dummy slack columns. Zero external dependencies in pure TypeScript.
   - _Cons:_ Cubic scaling if batch size exceeds several hundred pairs.

## Decision

1. **Rectangular Hungarian Formulation (`BatchedPolicy`):**
   We implement `BatchedPolicy` in `@hexdispatch/matching` using potentiated Kuhn-Munkres augmenting paths.
   - For $R$ riders and $D$ drivers, we construct an $R \times (D + R)$ matrix.
   - Real drivers ($0 \le j < D$):
     $$\text{cost}(r, d) = \text{pickupETA}(r, d) - \text{idleBonus}(d)$$
     where $\text{idleBonus}(d) = \min(\text{maxIdleBonusSec}, \text{idleSec} \cdot \text{idleWeight})$.
   - Dummy "unmatched" columns ($D \le j < D + R$):
     $$\text{cost}(r, \text{unmatched}_r) = \text{unmatchedBaseCostSec} + \text{waitPenalty}(r)$$
     where $\text{waitPenalty}(r) = \text{waitWeight} \cdot \text{waitSec}$.
   - Other dummy columns ($k \ne r$) and infeasible pairs ($\text{ETA} > \text{maxPickupEtaSec}$ or excluded drivers) receive $10^7$ ($\text{INFEASIBLE\_COST}$).

2. **Region Sharding & H3 Ownership:**
   - Matcher ownership is determined by the parent H3 cell at resolution `H3_MATCHER_OWNER_RES` (res 6).
   - `ride.requested` is keyed by the pickup cell's res 6 parent.
   - Border drivers are visible to neighbouring cells during spatial queries; Redis Lua atomic claims (`SET claim:{driverId} ... NX EX`) guarantee that no driver is ever double-assigned across regions.

3. **Batch Threshold (`BATCH_MAX_CELLS` = 10,000):**
   - Benchmarks show 50x50 batches solve in ~1.1 ms (p50) and ~6.5 ms (p95); 100x100 solves in ~12 ms.
   - If $R \times D > 10,000$, `BatchedPolicy` safely falls back to `GreedyPolicy` to preserve strict window deadlines.

4. **Window Lag Fallback & Observability:**
   - If batch window lag exceeds `BATCH_LAG_FALLBACK_MS` (5,000 ms) or an unhandled error occurs, `DispatchEngine` executes `GreedyPolicy` for that window.
   - Increments Prometheus counter `dispatch_fallback_total` and emits `dispatch.batch.completed` with `fallback: true` and `policy: 'greedy'`.

## Consequences

- Optimal global assignment cost verified against brute-force solver on randomised small instances ($n \le 7$, 120 test cases).
- Zero double-assignments across regions verified under concurrent stress testing.
- Significant reduction in `NO_DRIVER_FOUND` rate (e.g. from 66.1% down to 11.4% in Peak scenario) and ~15% higher completed trip throughput.
