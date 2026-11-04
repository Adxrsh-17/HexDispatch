# Phase 4: City simulator

**Goal:** a reproducible way to measure any dispatch policy.

**Estimated time:** 1 week.

**Tech used:** TypeScript, `tools/simulator`, `packages/matching`, h3-js, a seeded PRNG (for example mulberry32 or sfc32, implemented locally), CSV output, chart generation (SVG/PNG via a small charting library or hand-written SVG), Vitest.

## Tasks

1. Seeded RNG module. No `Math.random()` anywhere in the simulator. Sub-streams per concern (demand, drivers, acceptance) so changing one model does not shift the others.
2. Discrete-event engine: event queue ordered by time then sequence number, deterministic tie-breaking.
3. City model: bounded area, H3 cells (res 8), travel time = distance / speed with a speed multiplier (variation, optional rain slowdown).
4. Demand model: Poisson arrivals with hotspots, time-of-day curve, burst events (concert end, rain).
5. Driver model: shift start/end, roaming when idle, acceptance probability, decline/timeout behaviour, earnings tracking.
6. Scenarios as files (`tools/simulator/scenarios/*.json`): `normal`, `peak` (evening peak), `rain` (rain shock).
7. In-process mode: calls `MatchingPolicy.match()` from `packages/matching` directly, windowed or per-request depending on policy, the same code production uses. (End-to-end API mode is optional here and may be a later add-on.)
8. Metrics: pickup ETA avg and p95, match rate, no-driver rate, cancellation rate, driver utilisation, idle time, rides per driver-hour, earnings spread (for example Gini or p90/p10).
9. Report generator: CSV + charts, with scenario name, policy, seed, git commit and command embedded in the output.
10. CLI: `pnpm sim --scenario peak --policy greedy --seed 42`.
11. Run the greedy baseline on all three scenarios and commit the report under `docs/benchmarks/`.

## Acceptance criteria

1. Same scenario + policy + seed produce byte-identical metric output (test runs twice and compares).
2. Different seeds produce different results (sanity test).
3. At least three scenarios exist: normal, peak, rain.
4. The greedy baseline report with all metrics is committed under `docs/benchmarks/`, with the exact commands and seeds used.
5. The simulator imports and runs `packages/matching` (no copy of the algorithm).

## Out of scope

Batched policy, surge/elasticity (Phase 6), real road networks, trust/GPS anomaly injection (Phase 8), end-to-end API mode unless time allows.
