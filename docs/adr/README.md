# Architecture Decision Records (ADRs)

This directory documents all foundational architectural and technology decisions across the HexDispatch platform. Every non-obvious engineering choice is recorded with context, alternatives considered, rationale, and consequences.

| ADR Number                                                | Title                                          | Status   | Date       | Core Themes                                                                                |
| :-------------------------------------------------------- | :--------------------------------------------- | :------- | :--------- | :----------------------------------------------------------------------------------------- |
| [**0001**](0001-tech-stack.md)                            | Tech Stack Foundations                         | Accepted | 2026-11-04 | Node >=22, TypeScript strict, Fastify 5, Redpanda, Redis 7, Postgres 16                    |
| [**0002**](0002-core-api-and-outbox-relay.md)             | Core API & Transactional Outbox Relay          | Accepted | 2026-11-04 | Dual-write protection, skip-locked polling, idempotency keys, single trip transition table |
| [**0003**](0003-location-ingest-and-realtime-fanout.md)   | Location Ingest & Real-Time Fanout             | Accepted | 2026-11-04 | H3 spatial indexing, micro-batching publisher, bounded queues, Redis pub/sub               |
| [**0004**](0004-baseline-dispatch-and-offers.md)          | Baseline Dispatch & Offer Lifecycle            | Accepted | 2026-11-04 | Ephemeral Redis lock claims, timeout expiry, re-offer ladder, mid-crash recovery           |
| [**0005**](0005-seeded-city-simulator.md)                 | Seeded Discrete-Event City Simulator           | Accepted | 2026-11-04 | Zero `Math.random()`, reproducible benchmarks, haversine movement, Gini inequality metric  |
| [**0006**](0006-batched-matching-hungarian.md)            | Batched Matching & Hungarian Assignment        | Accepted | 2026-11-04 | Kuhn-Munkres $O(n^3)$ minimum-cost matching, H3 region sharding, greedy fallback           |
| [**0007**](0007-pricing-and-surge.md)                     | Dynamic Pricing & Surge Control Loop           | Accepted | 2026-11-04 | Locked upfront quotes, EWMA smoothing, per-step change clamp, spatial roaming bias         |
| [**0008**](0008-payments-saga-and-double-entry-ledger.md) | Idempotent Payments Saga & Double-Entry Ledger | Accepted | 2026-11-04 | Saga state machine, timeout query-before-retry, double-entry invariant $\sum D = \sum C$   |
| [**0009**](0009-trust-rules-and-chaos-resilience.md)      | Trust Rules, Circuit Breakers & Resilience     | Accepted | 2026-11-04 | Kinematic anomaly detection, circuit breaker 3-state machine, backpressure load shedding   |
