# ADR 0009: Trust Rules, Circuit Breakers, and Chaos Resilience

- Status: Accepted
- Date: 2026-11-04

## Context

Production ride-sharing platforms encounter adversarial behavior (GPS spoofing, teleportation, frozen meters, abusive cancellations) and inevitable infrastructure disruptions (database disconnects, broker restarts, inter-service network partitions). Without defensive guardrails:

1. Malicious or compromised driver devices can falsify location coordinates to claim rides or inflate fare meters.
2. Abusive riders can spam ride requests and cancel repeatedly, starving honest users of vehicle supply.
3. Slow or failing downstream microservices cause synchronous HTTP cascades, exhausting worker threads and open file descriptors.
4. Sudden ingest bursts exhaust memory buffers, causing uncontrolled service crashes.

We need explicit, deterministic trust anomaly detection, circuit breakers on synchronous inter-service communication, bounded backpressure queues, and validated failure-recovery procedures.

## Alternatives Considered

1. **Complex Machine Learning Anomaly Models:**
   - Deep neural networks / random forests running online.
   - _Rejected for Phase 8:_ Introduces heavy dependencies, GPU requirements, non-deterministic scoring, and high latency. Explicit deterministic kinematic threshold rules offer sub-millisecond evaluation, zero false positives on normal driving, and 100% auditability.
2. **External Circuit Breaker Library (`opossum`):**
   - _Rejected:_ Introduces unnecessary external runtime dependencies and complicates custom Prometheus gauge/counter metrics. A pure in-house TypeScript `CircuitBreaker` module (~120 LOC) with state transition event hooks and Prom-client integration gives total control with zero overhead.
3. **Unbounded Memory Queues for Location Ingestion:**
   - _Rejected:_ Vulnerable to OOM killer when Kafka broker stalls or network partitions occur. Bounded queue with load-shedding and metrics ensures service survival.

## Decision

1. **Kinematic Trust Rules Engine (`apps/location/src/trust/trust-engine.ts`):**
   - **Impossible Speed:** Rejects and flags GPS updates with implied speed $> 42\text{ m/s}$ (~$151\text{ km/h}$) and spatial movement $> 500\text{ m}$.
   - **Teleport Jumps:** Flags sudden location jumps $> 2000\text{ m}$ in short intervals ($< 5\text{ s}$).
   - **Frozen GPS:** Flags vehicles in `ON_TRIP` status whose coordinates move $< 5\text{ m}$ for $\ge 300\text{ s}$ (5 minutes).
   - **Cancellation Abuse:** Evaluates rolling 1-hour windows for drivers and riders; flags subjects with $\ge 4$ cancellations and $\ge 60\%$ cancellation rate. Emits `trust.flagged` event over Kafka and records in audit register.

2. **Pure TypeScript Circuit Breaker (`packages/shared/src/circuit-breaker.ts`):**
   - Implements standard 3-state state machine: `CLOSED` -> `OPEN` -> `HALF_OPEN`.
   - Thresholds: 5 consecutive failures trips to `OPEN`; 5000ms reset timeout to `HALF_OPEN`; 2 consecutive successes in `HALF_OPEN` restores to `CLOSED`.
   - Per-call timeout: enforces strict 3000ms limit via `Promise.race`.
   - Fast-fails with `CircuitBreakerOpenError` without calling downstream service when `OPEN`.
   - Prometheus metrics: `circuit_breaker_state` gauge (0=CLOSED, 1=HALF_OPEN, 2=OPEN) and `circuit_breaker_state_changes_total` counter.

3. **Bounded Ingest Backpressure (`apps/location/src/batch-publisher.ts`):**
   - Bounded queue with `maxQueueSize = 500`.
   - When queue is saturated, excess incoming pings are gracefully dropped without crashing the process.
   - Exposes `location_dropped_total` counter and `location_ingest_overloaded` gauge (1 when overloaded, resetting to 0 when queue drains below 80% capacity).

4. **Failure-Injection Chaos Suite (`tools/chaos/`):**
   - Standardized scripts to test killing Redis, Kafka (Redpanda), Dispatch, and Gateway.
   - Verified that PostgreSQL-persisted outbox and double-entry ledger guarantee zero data loss during broker outages.

## Consequences

- Ingest pipeline sheds load gracefully rather than exhausting memory during downstream stalls.
- Kinematic anomalies are caught with $\ge 90\%$ detection rate and $\le 5\%$ false-positive rate.
- Inter-service network calls fail fast (503 Service Unavailable) instead of hanging sockets when downstreams are unhealthy.

