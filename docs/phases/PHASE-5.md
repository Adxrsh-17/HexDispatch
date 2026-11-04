# Phase 5: Batched matching

**Goal:** the core differentiator, compared against the baseline with evidence.

**Estimated time:** 1-1.5 weeks.

**Tech used:** `packages/matching` (pure TypeScript), Redis (Lua atomic claims), kafkajs, h3-js (parent/child cells), `tools/simulator`, Vitest + Testcontainers, prom-client.

## Tasks

1. Windowing: per-region batch timer (fixed 2 s; `BATCH_WINDOW_MS` config). Adaptive windows only if time remains.
2. Cost matrix builder in `packages/matching`: `pickupETA - idleBonus + waitPenalty`, infeasible rules, per-rider exclusions. Weights from config.
3. Hungarian solver (rectangular, with an "unmatched" column per rider) as `BatchedPolicy` implementing `MatchingPolicy`. Unit tests against brute force on randomised small instances (n <= 7) and known textbook cases. ADR: Hungarian vs min-cost flow.
4. Large-batch strategy: split by sub-region (res 7 children) or fall back to greedy above `BATCH_MAX_CELLS`. Threshold chosen from measured solver latency, recorded in an ADR.
5. Region sharding: ownership by parent cell at `H3_MATCHER_OWNER_RES`; `ride.requested` keyed by that cell; border drivers visible to neighbours; atomic claims resolve conflicts. ADR for the sharding scheme.
6. Carry-over of unmatched riders with a rising wait penalty (aging); decline/timeout re-entry with exclusions.
7. Fallback: batch error, time budget exceeded, or window lag over `BATCH_LAG_FALLBACK_MS` -> greedy for that window, `dispatch_fallback_total` metric, `dispatch.batch.completed` event with `policy` and `fallback` fields.
8. `match_decisions` rows carry `policy = 'batched'` and `batch_id`.
9. Simulator: add `--policy batched`; run all three scenarios for greedy and batched on identical seeds (several seeds each); write `docs/benchmarks/greedy-vs-batched.md` with tables, charts, commands, seeds, git commit. Include scenarios where batching does not win.
10. Measure matching latency (p50/p95) versus batch size and record it.

## Acceptance criteria

1. Solver output cost equals brute-force optimum on randomised small instances (test, fixed seeds, many cases).
2. No driver is ever assigned twice across regions in a stress test with concurrent matchers (assert across `match_decisions` and claims).
3. The comparison report on identical seeds shows measured differences in average pickup ETA, utilisation and match rate, reported honestly, including any scenario where batching does not help. Every number has its command and seed.
4. Matching latency for a representative batch size is measured and documented.
5. Killing the batched matcher triggers the fallback; no request is stuck (failure-injection test).
6. Typecheck, lint, tests pass; Testcontainers integration test for the batched path.

## Out of scope

Surge/pricing, payments, trust rules, min-cost-flow implementation (unless the ADR picks it), real road ETAs, ML-based cost models.
