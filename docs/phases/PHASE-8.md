# Phase 8: Trust and resilience (stretch)

**Goal:** show production thinking. Cut this phase first if time is short.

**Estimated time:** 4-5 days.

**Tech used:** kafkajs consumers over `location.updated`, Redis, h3-js, circuit-breaker logic (small in-house module or `opossum`), `tools/simulator` anomaly injection, shell/TypeScript failure-injection scripts, Docker CLI for killing containers.

## Tasks

1. Trust rules over `location.updated`: impossible speed, teleport jumps, frozen GPS during a trip, large route deviation. Risk score per driver; emit `trust.flagged` (key: subject id).
2. Cancellation-abuse detection for riders and drivers (rolling counts and rates); flag and expose via an admin endpoint.
3. Circuit breakers and timeouts on every inter-service HTTP call (closed/open/half-open, metrics for state changes). Per-user and per-IP rate limits already exist from Phase 1; add per-route limits where needed.
4. Backpressure on location ingest: bounded queue, sampling or dropping when overloaded, with `location_dropped_total` and an overload gauge.
5. Simulator anomaly injection (seeded): GPS jumps, frozen GPS, speed spikes, cancellation abusers, with known ground truth.
6. Failure-injection scripts under `tools/chaos/`: kill Redis, a Kafka broker (Redpanda), `dispatch`, a gateway node. Each script records behaviour and recovery time.
7. Document each scenario in `docs/resilience.md`: expected degraded behaviour, observed behaviour, data loss (yes/no), measured recovery time.

## Acceptance criteria

1. Injected GPS anomalies in the simulator are flagged with a measured detection rate and false-positive rate (command + seed recorded).
2. Each failure-injection scenario has a recorded outcome: degraded behaviour, no data loss (or an explicit statement of what was lost), and measured recovery time.
3. Circuit breaker unit tests cover the closed -> open -> half-open -> closed cycle.
4. Under an overloaded ingest test, the service sheds load without crashing and reports drops.
5. Typecheck, lint, tests pass.

## Out of scope

Machine-learning fraud models, device fingerprinting, identity verification, multi-region failover, Kubernetes.
