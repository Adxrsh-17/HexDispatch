# Phase 1: Core API

**Goal:** accounts, ride requests and a correct trip state machine, behind the gateway.

**Estimated time:** 1 week.

**Tech used:** Fastify, zod, Drizzle + drizzle-kit, PostgreSQL (`core`), JWT (`jose`), argon2 or bcrypt for passwords, Redis (rate limiting), kafkajs via the shared wrapper, OpenAPI (`@fastify/swagger` or generated from zod), Vitest + Testcontainers.

## Tasks

1. Schema and migrations in `core`: `users`, `drivers`, `rides`, `ride_events`, `outbox`, `idempotency_keys`.
2. Auth in `core-api`: signup, login, refresh, roles (RIDER, DRIVER, ADMIN), password hashing, JWT access + refresh. Driver profile + vehicle; `PATCH /drivers/me/status`.
3. Rides: `POST /rides` with `Idempotency-Key` (same key + same body returns the same ride, same key + different body is 422/409), `GET /rides/{id}`, `GET /rides?status=`, `POST /rides/{id}/cancel`. Fare estimate is a stub.
4. Table-driven trip state machine in `core-api`: one table of `TripTransition` rows (types from `packages/contracts`), a single `transition(rideId, to, actor, expectedVersion)` function, optimistic locking via `version`, `ride_events` audit row per change.
5. Transactional outbox: ride + event + outbox rows in one transaction. Relay process publishes `ride.requested` (key: pickup cell) and `trip.state.changed` (key: rideId) with `SELECT ... FOR UPDATE SKIP LOCKED`, marks `published_at` after the broker acks. Duplicates are possible; consumers are idempotent by `eventId`.
6. Gateway: JWT verification, role checks, Redis-backed rate limiting (per user and per IP), proxy to `core-api`, forward `Idempotency-Key` and `x-request-id`.
7. OpenAPI spec for gateway-exposed routes of core-api, served at `/docs` and committed as `docs/api/core-api.openapi.json`.
8. Metrics: request duration (already), `outbox_pending`, `outbox_publish_total`, `ride_transitions_total{from,to}`. Traces cover HTTP + DB + Kafka publish.

## Acceptance criteria

1. Repeating the same `POST /rides` with the same Idempotency-Key returns the same ride and creates exactly one row (integration test).
2. Every illegal transition is rejected (table-driven test over all state pairs). A concurrency test with parallel conflicting updates leaves a valid state and a consistent `ride_events` history.
3. Killing the relay mid-publish and restarting loses no events; a consumer using `eventId` idempotency sees each logical event exactly once (test).
4. Unauthenticated and wrong-role requests are rejected at the gateway; the rate limit returns 429 with `Retry-After`.
5. OpenAPI spec generated and committed.
6. Typecheck, lint, tests pass; Testcontainers integration test exists for `core-api`.

## Out of scope

Matching, offers, driver claims, location ingest, WebSockets, real fare/surge (stub only), payments, refresh-token rotation hardening beyond basics.
