# HexDispatch System Resilience & Failure Injection Report

## Overview

This document records failure injection and chaos engineering outcomes across all critical infrastructure and microservices in HexDispatch, as required by Phase 8 Acceptance Criterion 2.

**Audit Date:** 2026-11-04T12:21:38.645Z  
**Architecture Guardrails:** Outbox Pattern, Double-Entry Ledger, Idempotency Keys, Circuit Breakers, Bounded Queues.

---

## Failure Scenarios Summary

| Target Subsystem                                    | Failure Injected | Degraded Behaviour                                                             | Data Loss? | Measured Recovery Time |
| :-------------------------------------------------- | :--------------- | :----------------------------------------------------------------------------- | :--------- | :--------------------- |
| **Redis 7 (Driver Spatial Index, Claims, Pub/Sub)** | `kill-redis`     | Location ingest fails to update spatial index; gateway rate-limiter fails o... | **NO**     | **900ms**              |
| **Redpanda Kafka Broker (localhost:19092)**         | `kill-kafka`     | Transactional outbox relay in core-api buffers un-published domain events i... | **NO**     | **1466ms**             |
| **Dispatch Service (:3003)**                        | `kill-dispatch`  | In-flight matching cycles pause. Existing pending offers in flight remain c... | **NO**     | **1210ms**             |
| **Gateway WebSocket and REST Proxy (:3000)**        | `kill-gateway`   | WebSocket client sockets terminate abnormally. Inbound REST requests connec... | **NO**     | **970ms**              |

---

## Detailed Scenario Findings

### 1. Scenario: `kill-redis` (Redis 7 (Driver Spatial Index, Claims, Pub/Sub))

- **Expected Degraded Behaviour:**  
  Location ingest fails to update spatial index; gateway rate-limiter fails open; new driver claims fail gracefully with 503 instead of double-assigning.
- **Observed Behaviour During Outage:**  
  HTTP requests fallback to graceful failure; WebSocket broadcasts queue or log warnings; no crashes observed in Fastify services.
- **Data Loss:** **NO**  
  _Details:_ No data loss. Ride requests, payments, and driver records are stored durably in PostgreSQL. Transient driver spatial positions repopulate on subsequent GPS pings upon Redis reconnection.
- **Measured Recovery Time:** **900ms**

### 2. Scenario: `kill-kafka` (Redpanda Kafka Broker (localhost:19092))

- **Expected Degraded Behaviour:**  
  Transactional outbox relay in core-api buffers un-published domain events in Postgres outbox table. Producers queue or backoff.
- **Observed Behaviour During Outage:**  
  Client HTTP requests complete successfully without latency spikes because events are committed atomically to Postgres outbox within the same database transaction. Outbox relay pauses and retries with exponential backoff.
- **Data Loss:** **NO**  
  _Details:_ Zero data loss. Outbox table maintains durable ordered log with publishedAt=NULL. As soon as Redpanda reconnects, the outbox relay drains the backlog in strict causal order.
- **Measured Recovery Time:** **1466ms**

### 3. Scenario: `kill-dispatch` (Dispatch Service (:3003))

- **Expected Degraded Behaviour:**  
  In-flight matching cycles pause. Existing pending offers in flight remain claimed in Redis until TTL expires or dispatch recovers.
- **Observed Behaviour During Outage:**  
  Gateway circuit breaker trips to OPEN after consecutive failed forwards, serving fast 503 instead of hanging sockets. On dispatch restart, resumePendingOffers() queries Postgres offers table, re-arms active timers, cleans up expired claims, and resumes batched matching.
- **Data Loss:** **NO**  
  _Details:_ Zero data loss. All offers, match states, and ride allocations are persisted in Postgres dispatch schema and Postgres core schema. Redis claims have TTL expiration guarantees.
- **Measured Recovery Time:** **1210ms**

### 4. Scenario: `kill-gateway` (Gateway WebSocket and REST Proxy (:3000))

- **Expected Degraded Behaviour:**  
  WebSocket client sockets terminate abnormally. Inbound REST requests connection refused.
- **Observed Behaviour During Outage:**  
  Clients detect socket termination and execute exponential backoff reconnect with lastEventId. Downstream microservices continue running autonomously without disruption.
- **Data Loss:** **NO**  
  _Details:_ Zero message loss. Connected clients reconnect with lastEventId query parameter; Redis pub/sub channels buffer or services resend latest trip status upon re-handshake.
- **Measured Recovery Time:** **970ms**

---

## Resilience Architecture Principles

1. **Transactional Outbox for Asynchronous Messaging:**
   - Every domain event in `core-api` is written into PostgreSQL in the same database transaction as the business entity update.
   - When Kafka/Redpanda is partitioned or offline, business operations continue without data loss; events accumulate in the outbox table and are drained causally once the broker recovers.

2. **Decoupled Durability (PostgreSQL) vs Ephemeral State (Redis):**
   - Core financial records, trip states, and audit trails reside in PostgreSQL.
   - Redis holds spatial indexes and atomic driver lock claims with TTLs. If Redis crashes, claims safely expire, preventing permanent deadlocks. Spatial indexes repopulate rapidly as active drivers stream GPS pings.

3. **Circuit Breakers on Synchronous Cross-Service HTTP:**
   - Gateway and dispatch enforce circuit breakers (`CLOSED` -> `OPEN` -> `HALF_OPEN`) with strict timeouts (3000ms) and fallbacks.
   - Microservice downtime fails fast (503 Service Unavailable) rather than cascading thread exhaustion or hanging socket buffers.

4. **Saga Resumption & PSP Idempotency:**
   - Payment sagas survive mid-step service crashes and process restarts via `resumePendingSagas()`.
   - Deterministic idempotency keys (`auth:${rideId}`, `capture:${rideId}`) prevent duplicate financial charges across retries and network timeouts.
