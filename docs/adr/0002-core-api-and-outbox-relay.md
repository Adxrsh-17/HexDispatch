# ADR 0002: Core API, Trip State Machine and Transactional Outbox

- Status: Accepted
- Date: 2026-11-04

## Context

Phase 1 requires user and driver account management, ride booking, trip lifecycle progression, event publication, and secure API routing behind the Gateway. Key reliability challenges in this architecture include:

1. Preventing double booking or inconsistent state mutations from concurrent requests or client retries.
2. Guaranteeing zero event loss when notifying downstream services (e.g. dispatch, pricing, location) of ride requests and state transitions.
3. Rejecting unauthorized access, wrong roles, and noisy clients at the perimeter.

## Decision

1. **Table-Driven Trip State Machine:**
   The trip state machine is implemented via a single source-of-truth transition table (`TRIP_TRANSITIONS`) mapping allowed `(from, to, actor)` edges. Transitions enforce optimistic concurrency control via a numeric `version` column on the `rides` table. Every successful transition records an immutable audit record in `ride_events` and an outbox event in the same atomic transaction.

2. **Transactional Outbox with PostgreSQL `SKIP LOCKED`:**
   Instead of direct Dual-Writes to Postgres and Kafka, event envelopes (`ride.requested`, `trip.state.changed`) are written to an `outbox` table in the same transaction as the ride state change. An `OutboxRelay` background worker retrieves pending events using `SELECT ... FOR UPDATE SKIP LOCKED` to allow multiple concurrent relay instances without contention or deadlocks, marking `published_at` once the message broker acknowledges receipt. Consumers deduplicate incoming events using the unique `eventId` envelope attribute.

3. **Perimeter Security and Rate Limiting:**
   `gateway` acts as the reverse proxy for all client traffic:
   - Evaluates JWT tokens using `jose`.
   - Enforces Role-Based Access Control (RBAC) prior to forwarding.
   - Redis-backed rate limiting (with in-memory fallback) returning HTTP 429 and `Retry-After` headers when limits are breached.
   - Forwards trace headers (`x-request-id`), idempotency keys (`idempotency-key`), and verified user claims (`x-user-id`, `x-user-role`).

4. **Idempotency Strategy:**
   An `idempotency_keys` table persists `(key, user_id, request_hash, response_code, response_body)`. Repeated requests with the exact same payload return the cached response with zero duplicate database writes. Requests reusing an existing key with altered payloads are rejected with HTTP 422 (`IDEMPOTENCY_CONFLICT`).

## Consequences

- Trip status cannot change through ad-hoc queries; all transitions adhere to validated paths and write audit records.
- Outbox pattern guarantees at-least-once message delivery to Kafka without loss even if the relay crashes mid-batch.
- End-to-end trace correlation and uniform error formats (`AppError`) ensure observability across gateway and services.
