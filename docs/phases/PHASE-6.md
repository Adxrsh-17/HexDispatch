# Phase 6: Pricing and surge

**Goal:** quotes with surge that responds to imbalance without flapping.

**Estimated time:** 1 week.

**Tech used:** Fastify, zod, PostgreSQL (`pricing`), Drizzle, Redis (sliding windows, `surge:{cell}`), h3-js (ring-1 neighbours), kafkajs, `tools/simulator`, Vitest + Testcontainers.

## Tasks

1. Fare model: base + per-km + per-minute, minimum fare, rounding in integer minor units. Pure functions with unit tests.
2. `POST /quotes`: compute fare with current surge, store a locked quote with `expires_at` (TTL), return `quote_id`. `core-api` stores the quote id on the ride; the final fare uses the locked quote.
3. Demand and supply measurement per cell in Redis sliding windows (requests from `ride.requested`, drivers from the location index).
4. Surge loop (every `SURGE_INTERVAL_SEC`, default 30): EWMA, clamp, step limit, hysteresis, neighbour blending, per `docs/PROJECT_PLAN.md` section 6. Pure computation in a testable module; the scheduler is thin.
5. Publish `pricing.surge.updated` on change; cache current surge per cell; append `surge_history`.
6. `GET /surge?lat=&lng=`, `GET /surge/{cell}/explain` (all inputs and intermediates), `PUT /admin/surge/{cell}` with expiry and an audit row.
7. Simulator: rider price elasticity (probability of abandoning rises with price) and driver repositioning toward high-surge cells. Both seeded and configurable.
8. Metrics: `surge_multiplier{cell}`, `surge_changes_total`, `surge_time_above_threshold_seconds`, quote counters.
9. Simulator comparison, peak scenario: with and without surge, on identical seeds. Report in `docs/benchmarks/`.

## Acceptance criteria

1. A quote is stable within its TTL, expires after it, and the ride's final fare equals the locked quote (tests).
2. Stability test: under steady demand the multiplier converges and does not oscillate (assert bounded changes per hour and no sign-flipping beyond the hysteresis band).
3. Step limit, clamp and hysteresis are each unit-tested with edge cases.
4. Explain endpoint output reproduces the multiplier from its listed inputs (test).
5. Simulator report shows the measured effect of surge on unmatched requests at peak, including any adverse effects.

## Out of scope

Payments and ledger, per-rider personalised pricing, ML demand forecasting, real taxes and fees.
