# ADR 0004: Baseline Dispatch Engine, Atomic Driver Claims, and Offer Lifecycle

- Status: Accepted
- Date: 2026-11-04

## Context

Phase 3 requires a production-grade baseline dispatch engine capable of matching ride requests to available drivers, managing offer delivery and responses (accept, decline, timeout), driving trips through state transitions, and preventing double assignment under heavy concurrency. Key architectural requirements include:

1. **Anti-Double-Assignment:** Under concurrent ride requests, a driver must never hold more than one active offer or be assigned to more than one active trip.
2. **Crash & Restart Resilience:** If the dispatch service crashes or restarts mid-offer, no offer, claim, or ride must remain stuck in an inconsistent state.
3. **Re-Offer Lifecycle:** Declines and timeouts must release driver claims immediately and cascade to the next optimal candidate up to `MAX_OFFER_ATTEMPTS`.
4. **Pure Matching Policy Abstraction:** Matching logic must remain decoupled from database, network, and framework dependencies to enable algorithmic benchmarking against future batch/Hungarian solvers.
5. **Real-time Observability:** Every match decision must be recorded immutably, and state notifications pushed instantly to clients via Gateway WebSockets.

## Decision

1. **Atomic Driver Claims via Redis Lua Scripts:**
   Driver availability and claims are managed in Redis with atomic Lua scripts:
   - `acquireClaim(driverId, ownerToken, ttlSec, state)`: Evaluates `GET driver:claim:{id}`. If unset, sets claim with state (`OFFER` or `TRIP`), owner token (e.g. `offerId`), and TTL. Returns 1 on success, 0 on contention.
   - `releaseClaim(driverId, ownerToken)`: Releases claim only if the current owner matches the caller's token, preventing accidental deallocations by expired or raced operations.
   - `upgradeClaim(driverId, ownerToken, ttlSec)`: Atomically upgrades an active claim from `OFFER` to `TRIP` and extends TTL upon offer acceptance.

2. **Pluggable Policy Registry & Pure Matching Package:**
   `packages/matching` defines pure, deterministic matching interfaces (`MatchingPolicy`, `RideRequest`, `DriverCandidate`, `MatchResult`) without any I/O.
   `apps/dispatch` uses a `MatchingRegistry` configured via `MATCHING_POLICY` (defaulting to `GreedyPolicy`). Every decision generates an immutable record in PostgreSQL `match_decisions` containing policy name, computed ETA/cost, candidate count, and batch id (`null` for greedy).

3. **Offer Lifecycle & Cascade Re-Offering:**
   - Offers are recorded in the PostgreSQL `offers` table and keyed in Redis as `offer:{rideId}:{driverId}` with TTL matching offer duration.
   - In-memory Node.js timers handle active timeouts.
   - When an offer is declined or expires, the driver claim is released, the driver is appended to the ride's `excludedDriverIds` set, and dispatch is triggered for the next closest candidate.
   - If candidate exhaustion occurs or `attempts >= MAX_OFFER_ATTEMPTS`, the ride transitions to `NO_DRIVER_FOUND`.

4. **Idempotency & Startup Crash Recovery:**
   - Consumed `ride.requested` events are checked against PostgreSQL `processed_events(eventId)` to guarantee idempotency.
   - On startup, `OfferManager.recoverPendingOffers()` scans all database offers with status `PENDING`. Offers whose deadline has passed are expired and cleaned up; offers with remaining TTL re-arm in-memory timeout timers.

5. **Trip Driving and Gateway WebSocket Fanout:**
   - Driver trip progression endpoints (`/rides/:id/arrived`, `/rides/:id/start`, `/rides/:id/complete`) trigger Core API transitions and push events via Redis Pub/Sub channels (`pubsub:room:driver:{id}` and `pubsub:room:ride:{id}`).
   - Upon completion, driver claims are released, freeing drivers for subsequent dispatches.

## Consequences

- Prevents race conditions and double-assignment guarantees under high concurrency (verified under 10 concurrent requests competing for 3 drivers).
- Pure matching algorithms in `packages/matching` allow automated benchmarking against future batch solvers (Phase 5).
- Clean recovery on restart prevents stuck rides and orphaned driver locks.
