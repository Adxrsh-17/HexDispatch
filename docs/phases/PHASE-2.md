# Phase 2: Location and realtime

**Goal:** ingest driver location at volume and stream it to riders.

**Estimated time:** 1 week.

**Tech used:** Fastify, `@fastify/websocket`, Redis (ioredis, Lua, pub/sub), h3-js, kafkajs, k6, Vitest + Testcontainers.

## Tasks

1. `location` service: `POST /drivers/me/location` and a WebSocket ingest variant. Validate with zod: bounds, timestamp freshness, speed sanity; reject out-of-order pings.
2. Redis driver index: `driver:{id}` hash (lat, lng, heading, speed, status, ts) with TTL; `cell:{h3}:drivers` sets at `H3_CELL_RES`; move a driver between cell sets atomically (Lua) when the cell changes.
3. Nearby search: H3 k-ring around the pickup, expanding ring by ring until enough candidates or a max ring; returns distance-sorted candidates. `GET /drivers/nearby` (internal).
4. Batch publish `location.updated` to Kafka (key: driverId), flushing by size or interval.
5. `gateway` WebSocket: JWT auth, ride rooms (`ride:{id}`), driver offer channel, heartbeats (ping/pong), event ids per room, reconnect with `lastEventId` replay from a bounded Redis stream.
6. Multi-node fan-out: two gateway nodes share events through Redis pub/sub; a rider on either node receives updates.
7. Demo page (plain HTML + JS, served by the gateway in dev) showing a moving driver on a map during a ride (simulated pings).
8. k6 load script for pings. Metrics: `location_pings_total`, `location_ingest_duration_seconds`, `ws_connections`, `ws_messages_sent_total`, `location_batch_size`.

## Acceptance criteria

1. Nearby query matches a brute-force haversine search on randomised data (property-style test; same set within the search radius).
2. Stale drivers disappear after the TTL. A driver crossing cells appears in exactly one cell set at all times (test).
3. Two gateway nodes both deliver updates to a rider connected to either; reconnect with `lastEventId` resumes without gaps or duplicates (test).
4. `location.updated` batches reach Kafka with correct keys (integration test).
5. A k6 run records sustained pings/s and p95 ingest latency. Numbers go to `docs/benchmarks/` with the command and machine; nothing is estimated.

## Out of scope

Matching, offers, trust rules (Phase 8), backpressure/sampling (Phase 8), production-grade map UI, mobile clients.
