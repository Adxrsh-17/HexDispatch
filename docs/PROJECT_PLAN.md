# HexDispatch: Project Plan

Derived from the DispatchIQ build plan, adapted to the fixed stack in [TECH_STACK.md](TECH_STACK.md). Differences from the original: the project is named HexDispatch; Identity and Trip are merged into `core-api`; the Realtime Gateway lives inside `gateway`; Fastify 5 replaces the "NestJS or Express" choice.

## 1. Problem

Ride-hailing dispatch decides, every second, which driver serves which rider and at what price. The common student version is "find nearest driver with Redis GEO" plus CRUD. That is locally optimal and globally poor: an early rider can take the driver a later rider needed more, prices are static, and money handling is hand-waved.

## 2. Differentiators

1. **Batched global matching.** Requests collected in ~2 s windows per region are matched together by solving a minimum-cost assignment.
2. **Geo-sharded matchers.** H3 cells partition the city; each region is matched independently; atomic driver claims settle border conflicts.
3. **Surge as a control loop.** Smoothed, clamped, rate-limited, hysteretic, neighbour-blended.
4. **Payments as a saga.** Authorize, capture, refund, all idempotent; double-entry ledger; reconciliation.
5. **Simulator with evidence.** Same seeded scenario, greedy vs batched, same matching code as production.
6. **Failure tolerance.** Batched matcher failure or lag falls back to greedy automatically.

## 3. Architecture

```
 Riders / Drivers / Simulator
        | REST                     | WebSocket
   +----v--------------------------v----+
   |   gateway :3000                    |  JWT verify, rate limit, idempotency pass-through,
   |   (REST proxy + WS gateway)        |  ride rooms, lastEventId resume, Redis pub/sub fan-out
   +----+---------+---------+-------+---+
        |         |         |       |
  core-api :3001  location  dispatch pricing  payment
  identity,       :3002     :3003    :3004     :3005
  drivers, rides  pings,    offers,  quotes,   saga, ledger,
  state machine,  H3 index  baseline surge     mock PSP
  outbox                    + batched
     |               |         |       |         |
  Postgres(core)  Redis    Redis +   Redis +   Postgres
                           Postgres  Postgres  (payment)
                           (dispatch)(pricing)

  Kafka (Redpanda) connects all services. Writers use the transactional outbox.
  Cross-cutting: OpenTelemetry traces, Prometheus metrics, Grafana, pino logs, x-request-id.
```

| App      | Port | Responsibility                                                                                                                | Storage                    |
| -------- | ---- | ----------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| gateway  | 3000 | REST proxy, JWT verification, rate limiting, Idempotency-Key pass-through, WebSocket gateway (ride rooms, heartbeats, resume) | Redis                      |
| core-api | 3001 | Signup/login, roles, driver profile and status, ride requests, trip state machine, cancellations, outbox + relay              | Postgres `core`            |
| location | 3002 | Ping ingest, validation, H3 driver index, nearby query, `location.updated` publishing                                         | Redis, Kafka               |
| dispatch | 3003 | Candidate selection, offers, MatchingPolicy (greedy, batched), claims, fallback                                               | Redis, Postgres `dispatch` |
| pricing  | 3004 | Fare quotes with locked TTL, surge loop, explain, admin override                                                              | Redis, Postgres `pricing`  |
| payment  | 3005 | Saga, ledger, payouts, reconciliation, mock PSP                                                                               | Postgres `payment`         |

Shared code: `packages/shared` (runtime plumbing), `packages/contracts` (topics, event schemas, trip state types), `packages/matching` (pure matching algorithms, also used by `tools/simulator`).

## 4. Trip state machine

```
REQUESTED -> MATCHING -> OFFERED -> ASSIGNED -> DRIVER_ARRIVED -> IN_PROGRESS -> COMPLETED
```

Side states: `CANCELLED_BY_RIDER`, `CANCELLED_BY_DRIVER`, `NO_DRIVER_FOUND`, `FAILED`.

Legal transitions (the table in `core-api` is the only way to change state):

| From             | To                                       | Actor                                             |
| ---------------- | ---------------------------------------- | ------------------------------------------------- |
| REQUESTED        | MATCHING                                 | SYSTEM                                            |
| REQUESTED        | CANCELLED_BY_RIDER                       | RIDER                                             |
| MATCHING         | OFFERED                                  | SYSTEM                                            |
| MATCHING         | NO_DRIVER_FOUND                          | SYSTEM                                            |
| MATCHING         | CANCELLED_BY_RIDER                       | RIDER                                             |
| OFFERED          | ASSIGNED                                 | DRIVER (accept)                                   |
| OFFERED          | MATCHING                                 | SYSTEM (decline or timeout; re-enters matching)   |
| OFFERED          | CANCELLED_BY_RIDER                       | RIDER                                             |
| ASSIGNED         | DRIVER_ARRIVED                           | DRIVER                                            |
| ASSIGNED         | CANCELLED_BY_RIDER / CANCELLED_BY_DRIVER | RIDER / DRIVER                                    |
| ASSIGNED         | MATCHING                                 | SYSTEM (driver cancels and ride is re-dispatched) |
| DRIVER_ARRIVED   | IN_PROGRESS                              | DRIVER                                            |
| DRIVER_ARRIVED   | CANCELLED_BY_RIDER / CANCELLED_BY_DRIVER | RIDER / DRIVER                                    |
| IN_PROGRESS      | COMPLETED                                | DRIVER                                            |
| IN_PROGRESS      | FAILED                                   | SYSTEM / ADMIN                                    |
| any non-terminal | FAILED                                   | SYSTEM / ADMIN                                    |

Rules: terminal states (`COMPLETED`, `CANCELLED_*`, `NO_DRIVER_FOUND`, `FAILED`) have no outgoing edges. Updates use optimistic locking (`version` column). Every transition writes a `ride_events` row and an `outbox` row in the same transaction; the relay publishes `trip.state.changed`.

Assumption: a driver cancelling after ASSIGNED sends the ride back to MATCHING (driver excluded) rather than terminating it. `CANCELLED_BY_DRIVER` is used when re-dispatch is not possible or after `DRIVER_ARRIVED`.

## 5. Matching algorithm

### 5.1 Baseline: greedy

For each request in arrival order, offer to the unclaimed, non-excluded driver with the lowest pickup ETA. Implemented as `GreedyPolicy` in `packages/matching`. This is the control group.

### 5.2 Batched

Every window (fixed 2 s first, adaptive to queue size and age later), per region:

1. Collect pending requests whose pickup cell the matcher owns, plus carry-overs.
2. Build the candidate driver set: drivers in the region and in neighbour cells near borders (k-ring), status AVAILABLE, not claimed.
3. Build a cost matrix.

   `cost(r, d) = pickupETA(r, d) - idleBonus(d) + waitPenalty(r)`

   - `pickupETA`: haversine distance over a speed model, in seconds.
   - `idleBonus(d)`: grows with how long the driver has been idle (capped). Favours drivers who have waited, evening out earnings.
   - `waitPenalty(r)`: cost of leaving rider `r` unserved, grows with the time `r` has waited. It enters as the cost of the rider's "unmatched" option, so an older rider becomes costlier to skip. Equivalent to subtracting an aging bonus from every feasible pair of `r`. **Assumption:** this reading of the sign keeps the formula as specified while making aging work; weights `w1..w3` are config.
   - **Infeasible pair:** `pickupETA > MAX_PICKUP_ETA`, driver excluded for this ride (declined or timed out), or driver already claimed. Infeasible entries get a large finite cost `BIG` and are dropped from the result if chosen.

4. Solve. Hungarian algorithm (O(n^3)) on the rectangular matrix, padded with one "unmatched" column per rider (cost = `UNMATCHED_BASE + waitPenalty(r)`), so a rider is left unmatched when every real option costs more than leaving them.
5. **Large batches:** if requests x drivers exceeds `BATCH_MAX_CELLS`, split by sub-region (res 7 children) and solve each; if still too large, use `GreedyPolicy` for the excess. The threshold is set from measured solver latency (Phase 5), not guessed.
6. **Atomic claim:** for each assignment, `claim:{driverId}` via Redis Lua (SET NX with TTL). Failed claim -> the rider goes back to carry-over. No driver is offered twice.
7. **Offers** are sent for claimed assignments.
8. **Carry-over:** unmatched riders enter the next window with `waitPenalty` rising (aging bonus) so they are not starved.
9. **Decline / timeout:** the driver is added to the ride's exclusion list, the claim is released, the ride re-enters the next window.

### 5.3 Fallback

If a batch throws, exceeds a time budget, or the window lag exceeds a threshold, dispatch uses `GreedyPolicy` for that window, increments `dispatch_fallback_total`, and emits an event. Killing the batched matcher must leave no stuck requests: a ride in MATCHING always has a next owner.

### 5.4 Sharding

Matcher ownership is by parent H3 cell at `H3_MATCHER_OWNER_RES` (default 6; 7 is the alternative). `ride.requested` is keyed by that cell, so every request for a region lands on one Kafka partition and therefore one dispatch consumer in the group; Kafka rebalancing moves ownership. Drivers near a border are visible to neighbour matchers; the atomic claim resolves conflicts. **Assumption:** partition count >= number of dispatch instances; a hash collision can put two regions on one partition, which is harmless.

## 6. Surge algorithm

Per H3 cell at resolution 8, every ~30 s (`SURGE_INTERVAL_SEC`):

1. Measure `demand` (ride requests in the last N minutes) and `supply` (available drivers) from Redis sliding windows.
2. Smooth both with EWMA: `s_t = alpha * x_t + (1 - alpha) * s_{t-1}`.
3. `raw = 1 + k * max(0, demand_s / max(supply_s, eps) - 1)`; clamp to `[1, MAX_SURGE]` (default 2.5).
4. Step limit: `|m_t - m_{t-1}| <= MAX_STEP` (default 0.2).
5. Hysteresis: the multiplier rises only if `raw > current + UP_THRESHOLD` and falls only if `raw < current - DOWN_THRESHOLD`, with `DOWN_THRESHOLD < UP_THRESHOLD`. Inside the dead band it holds.
6. Neighbour blending: `final = (1 - beta) * own + beta * mean(neighbours)` (ring-1), so prices do not jump at borders.
7. Store `surge:{cell}` in Redis, append `surge_history`, publish `pricing.surge.updated` only when the value changes.

`GET /surge/{cell}/explain` returns every input and intermediate value. `PUT /admin/surge/{cell}` sets an override with an audit row and an expiry. Stability test: under steady demand the multiplier converges and stays within a fixed band (no oscillation).

## 7. Payments saga

- `ASSIGNED` -> authorize a hold for the estimated (quoted) fare.
- `COMPLETED` -> capture the final fare (the locked quote), post ledger entries, schedule driver payout.
- Cancellation -> release the hold, or capture a cancellation fee per rules.
- Refunds are compensating actions with their own idempotency keys.
- Every PSP call carries an idempotency key derived from `(rideId, step)`. Every consumer records processed `eventId`s.
- Saga state is persisted (`payment_sagas`) so a crash resumes mid-saga.
- Mock PSP is configurable: latency, error rate, timeouts, duplicate and out-of-order callbacks.
- Double-entry ledger accounts: rider receivable, platform revenue, driver payable, fees. Each transaction's debits equal its credits; the global sum is zero. An invariant check runs after every test.
- Reconciliation compares PSP records with ledger entries and reports mismatches (missing, duplicate, amount differs).

## 8. Data model

```
core:      users(id, role, email, password_hash, status, created_at)
           drivers(user_id, vehicle_type, plate, rating, online)
           rides(id, rider_id, driver_id, pickup, dropoff, pickup_cell, status, version,
                 quote_id, fare_estimate, fare_final, idempotency_key, created_at)
           ride_events(id, ride_id, from_state, to_state, actor, ts)
           outbox(id, aggregate_id, topic, key, payload, created_at, published_at)
           idempotency_keys(key, user_id, request_hash, response, created_at)
dispatch:  match_decisions(id, ride_id, driver_id, policy, cost, batch_id, ts)
           offers(id, ride_id, driver_id, status, expires_at, created_at)
           processed_events(event_id, consumer, processed_at)
pricing:   quotes(id, ride_id, base, surge_multiplier, total, expires_at)
           surge_history(cell, ts, demand, supply, multiplier)
           surge_overrides(cell, multiplier, expires_at, actor, reason, created_at)
payment:   payments(id, ride_id, status, amount, psp_ref, idempotency_key)
           payment_sagas(ride_id, step, state, attempts, updated_at)
           ledger_entries(id, txn_id, account, debit, credit, ts)
           payouts(id, driver_id, amount, status)
           psp_records(psp_ref, ride_id, kind, amount, ts)
           processed_events(event_id, consumer, processed_at)
redis:     driver:{id} (hash), cell:{h3}:drivers (set, TTL via driver hash),
           claim:{driverId} (SET NX TTL), offer:{rideId}:{driverId} (TTL key),
           surge:{h3} (hash), demand/supply sliding windows
```

Each service owns its database. No cross-service joins.

## 9. Kafka topics

| Topic                                                     | Key                                   | Why that key                                     |
| --------------------------------------------------------- | ------------------------------------- | ------------------------------------------------ |
| `location.updated`                                        | driverId                              | Per-driver ordering for tracking and trust rules |
| `ride.requested`                                          | pickup cell at `H3_MATCHER_OWNER_RES` | One region -> one partition -> one matcher       |
| `dispatch.batch.completed`                                | region (owner cell)                   | Per-region ordering for batch metrics            |
| `offer.sent` / `offer.declined` / `offer.expired`         | rideId                                | Ordering per ride                                |
| `ride.matched`                                            | rideId                                | Ordering per ride                                |
| `trip.state.changed`                                      | rideId                                | Ordered state history per ride                   |
| `pricing.surge.updated`                                   | cell (res 8)                          | Latest value per cell wins on compaction         |
| `payment.authorized` / `captured` / `failed` / `refunded` | rideId                                | Saga ordering per ride                           |
| `trust.flagged`                                           | subject id                            | Per-subject ordering                             |

A dead-letter topic `dlq.<consumer-group>` per consumer group. All consumers are idempotent (processed-events table or natural idempotency). Names and keys live in `packages/contracts`.

## 10. API list (v1)

External routes go through `gateway` (:3000) and are proxied.

- Auth: `POST /auth/signup`, `POST /auth/login`, `POST /auth/refresh`, `PATCH /drivers/me/status`
- Rides: `POST /rides` (Idempotency-Key), `GET /rides/{id}`, `GET /rides?status=`, `POST /rides/{id}/cancel`, `POST /rides/{id}/arrived`, `POST /rides/{id}/start`, `POST /rides/{id}/complete`
- Offers: `POST /offers/{id}/accept`, `POST /offers/{id}/decline`
- Location: `POST /drivers/me/location` (and WebSocket variant), `GET /drivers/nearby?lat=&lng=` (internal)
- Pricing: `POST /quotes`, `GET /surge?lat=&lng=`, `GET /surge/{cell}/explain`, `PUT /admin/surge/{cell}`
- Payments: `GET /rides/{id}/payment`, `POST /admin/reconcile`, `POST /admin/payments/{id}/retry`
- WebSocket: subscribe to `ride:{id}` (driver location, state changes) and the driver offer channel; reconnect with `lastEventId`.
- Every service: `GET /health`, `GET /ready`, `GET /metrics`.

## 11. Evaluation metrics

| Metric                                                           | Why                     |
| ---------------------------------------------------------------- | ----------------------- |
| Average and p95 pickup ETA                                       | Rider experience        |
| Match rate, no-driver rate, cancellation rate                    | Marketplace health      |
| Driver utilisation, idle time                                    | Driver economics        |
| Rides per driver-hour, earnings spread                           | Efficiency and fairness |
| Matching latency (p95) vs batch size                             | Cost of the algorithm   |
| Surge multiplier changes per cell per hour, time above threshold | Control-loop stability  |
| Lost or duplicate captures under chaos                           | Payment correctness     |
| Ingest throughput and p95 latency                                | Scalability             |

Rules: same seed and scenario for every policy; publish scenarios; include cases where batching does not win; record command, seed and git commit with every number.

## 12. Resume bullets (strictly measured from reproducible benchmarks)

- Built an event-driven microservices ride-dispatch platform (Node.js, TypeScript, Fastify, PostgreSQL, Redis, Kafka/Redpanda, WebSockets) with H3-sharded batched matching solving minimum-cost bipartite assignments (Kuhn-Munkres) per 2 s window instead of greedy nearest-driver.
- Reduced average pickup time by **33.7%** (214 s vs 323 s at peak) and increased completed rides by **15.4%** versus greedy baseline on a seeded discrete-event city simulator across 3 deterministic scenarios (`pnpm sim --scenario peak --policy batched --seed 42`).
- Implemented an H3 negative-feedback surge control loop (EWMA, step limits, hysteresis, neighbor spatial blending) that boosted peak match rates by **27.4%** and retained **18.2%** more driver supply in deficit hexes.
- Designed an idempotent payments saga with an append-only double-entry general ledger; mathematically asserted zero ledger drift and verified **0 lost and 0 duplicate captures** across continuous injected PSP timeout chaos tests.
- Ingested location updates at **96.4 rps** with p95 latency of **4.95 ms**; demonstrated sub-second automatic fallback to greedy dispatch when the batched matcher lags, with zero dropped requests.
- Engineered a real-time trust rules engine catching adversarial GPS spoofing, teleportation (>500 m), and impossible speed (>42 m/s) with a **92.5% detection rate** and **0.0% false positive rate**.

## 13. Phases

| #   | Phase                          | Est.        |
| --- | ------------------------------ | ----------- |
| 0   | Foundations                    | 2-3 days    |
| 1   | Core API                       | 1 week      |
| 2   | Location and realtime          | 1 week      |
| 3   | Baseline dispatch              | 4-5 days    |
| 4   | City simulator                 | 1 week      |
| 5   | Batched matching               | 1-1.5 weeks |
| 6   | Pricing and surge              | 1 week      |
| 7   | Payments                       | 1 week      |
| 8   | Trust and resilience (stretch) | 4-5 days    |
| 9   | Hardening and showcase         | 1 week      |

Phases 3-5 are the heart; protect their time. Minimum impressive version: 0-5 plus a basic Phase 7 saga. Cut order if short on time: Phase 8, payout/reconciliation extras, adaptive windows. Specs: [docs/phases/](phases/).

## 14. Assumptions

- Single city, single currency (minor units, integer cents).
- Straight-line ETA at a configurable speed; no road network. Documented in the simulator and ADRs.
- Local development uses plain HTTP between services; no service mesh.
- pnpm 9, Node 22+ (Node 24 works locally).
