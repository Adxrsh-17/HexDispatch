# Phase 3: Baseline dispatch

**Goal:** a working end-to-end ride with greedy matching. This is the control group.

**Estimated time:** 4-5 days.

**Tech used:** Fastify, kafkajs, Redis (Lua), PostgreSQL (`dispatch`), Drizzle, `packages/matching`, `@fastify/websocket` pushes via the gateway, Vitest + Testcontainers.

## Tasks

1. `dispatch` consumes `ride.requested` (idempotent by `eventId`), moves the ride to MATCHING through `core-api`, queries nearby drivers from `location`, and calls the configured `MatchingPolicy`.
2. Wire `MatchingPolicy` to config (`MATCHING_POLICY=greedy`); registry maps names to policies. Only `greedy` exists now.
3. Offers: `offers` table plus `offer:{rideId}:{driverId}` TTL key in Redis. Accept, decline and timeout handling. On decline or timeout: exclude the driver, release the claim, re-offer to the next candidate; after `MAX_OFFER_ATTEMPTS` or no candidates, ride -> `NO_DRIVER_FOUND`.
4. Atomic driver claim in Redis (Lua): a driver holds at most one active offer or trip. Claim has a TTL and an owner token; release only by owner.
5. Drive the trip: accept -> ASSIGNED, then arrived, start, complete through `core-api` endpoints with the state machine; publish `offer.sent`, `offer.declined`, `offer.expired`, `ride.matched`.
6. Push offers and state changes to riders and drivers over WebSocket via the gateway.
7. `match_decisions` row for every decision with policy name, cost, batch id (null for greedy).
8. Recovery: on startup, re-arm timers for offers that are pending (from the database); expired offers are processed. Nothing stays stuck after a restart.
9. A scripted rider + driver client (`tools/scripts/e2e-ride.ts`) that completes a ride through the gateway.

## Acceptance criteria

1. The scripted rider and driver complete a full ride through the API.
2. A concurrency test with many simultaneous requests and few drivers never double-assigns a driver (assert on `match_decisions`, offers and claims).
3. Declines and timeouts re-offer correctly (tests with a fake clock and with real TTLs).
4. After killing and restarting `dispatch` mid-offer, no offer or ride is stuck (test).
5. Every decision is recorded in `match_decisions` with `policy = 'greedy'`.
6. Typecheck, lint, tests pass; Testcontainers integration test for `dispatch`.

## Out of scope

Batched matching, Hungarian solver, region sharding, fallback logic, surge/pricing, payments, driver repositioning.
