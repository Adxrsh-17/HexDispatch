# ADR 0005: Seeded City Simulator and Discrete-Event Engine

- Status: Accepted
- Date: 2026-11-04

## Context

Evaluating dispatch algorithms and pricing mechanisms in production or live staging environments is noisy, non-deterministic, and costly. Comparing different matching policies (such as Greedy vs Batched Min-Cost Assignment in Phase 5) requires an offline, byte-reproducible testbed where:

1. Identical simulation seeds always produce identical passenger demand, driver behaviors, and metric outputs.
2. Modifying one subsystem (e.g. demand intensity) does not accidentally disrupt the random stream of other processes (e.g. driver acceptance decisions).
3. The exact same matching logic implemented in `packages/matching` runs in the simulator without code duplication or mock drift.
4. Comprehensive operational metrics (pickup ETAs, match rate, driver utilization, driver earnings inequality via Gini coefficient) are measured systematically.

## Decision

1. **SFC32 PRNG and Sub-stream Isolation:**
   The simulator uses a deterministic 128-bit SFC32 pseudo-random number generator initialized via SplitMix32. Usage of `Math.random()` is strictly prohibited. An `RngManager` derives isolated sub-streams using 32-bit FNV-1a hashes for `demand`, `driver`, and `acceptance`. Changes to demand generation do not alter the random sequence observed by driver roaming or offer responses.

2. **Discrete-Event Simulation (DES) Engine:**
   Simulation state advances monotonically along a timeline using a binary min-heap `PriorityQueue`. Simultaneous events resolve ties deterministically using a monotonic sequence counter (`seq`).

3. **In-Process Algorithm Execution:**
   The simulator directly imports and invokes the production `MatchingPolicy` contract (`GreedyPolicy.match()`) from `@hexdispatch/matching`. No algorithmic code is cloned or mocked.

4. **Scenario Configuration as Code:**
   City parameters, fleet size, diurnal demand curves, and shock events are specified as structured JSON configurations under `tools/simulator/scenarios/` (`normal.json`, `peak.json`, `rain.json`).

5. **Automated Reporting and Artifact Generation:**
   Runs output structured metrics directly to `docs/benchmarks/`:
   - Summary and driver-level CSV data (`*-greedy-seed*.csv`).
   - SVG histograms of pickup ETA distributions (`*-eta.svg`).
   - Markdown executive reports embedding scenario, policy, seed, git commit, and command executed.

## Consequences

- Any two runs given the same scenario, policy, and seed yield byte-identical metric records (verified by automated Vitest suite).
- Provides an empirical benchmark baseline for Phase 5 to demonstrate the efficiency gains of batched H3 assignment over greedy dispatch.
- Fast execution (~50-80 ms for a 2-hour simulated city operation) enables fast regression testing in CI.
