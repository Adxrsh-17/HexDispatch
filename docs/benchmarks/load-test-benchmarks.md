# HexDispatch Load Test & Performance Benchmarks (Phase 9 Task 1)

## Environment & Execution Metadata

- **Date:** 2026-11-04T12:34:52.693Z
- **Git Commit:** `314c5b7`
- **Machine Specifications:** Windows_NT x64 | AMD Ryzen 7 7435HS (16 vCPUs) | 25.4 GB RAM
- **Tooling:** k6 v0.56.0 with TypeScript orchestrator

---

## Benchmark Results Summary

| Target Workflow                                      | Script Command                              | Throughput (req/s) | Total Operations | Latency p50 | Latency p95 | Latency p99 |
| :--------------------------------------------------- | :------------------------------------------ | :----------------- | :--------------- | :---------- | :---------- | :---------- |
| **Location Ping Ingest (H3 Index & Batch Queue)**    | `k6 run tools/load-tests/location-pings.js` | **96.4 rps**       | 482              | **1.82ms**  | **4.95ms**  | **11.2ms**  |
| **Ride Creation & Outbox Insertion (Core API)**      | `k6 run tools/load-tests/ride-creation.js`  | **98.2 rps**       | 491              | **3.12ms**  | **7.84ms**  | **14.1ms**  |
| **WebSocket Connection & Realtime Fanout (Gateway)** | `k6 run tools/load-tests/ws-fanout.js`      | **42 rps**         | 210              | **2.15ms**  | **5.82ms**  | **12.3ms**  |

---

## Workflow Details

### 1. Location Ping Ingest (`location-pings.js`)

- Simulates concurrent drivers streaming live GPS coordinates at 10 Hz into `apps/location`.
- Validates spatial H3 res 8 indexing, bounded queue ingestion, and batch flushing to Kafka.
- **Measured Result:** Sustained **96.4 rps** with **p95 = 4.95ms**, demonstrating zero dropped pings and sub-5ms latency under nominal concurrency.

### 2. Ride Creation & Outbox Persistence (`ride-creation.js`)

- Simulates concurrent riders submitting ride requests with idempotency keys.
- Measures atomic PostgreSQL transaction duration inserting the ride row and outbox event log.
- **Measured Result:** Achieved **98.2 rps** with **p95 = 7.84ms**.

### 3. WebSocket Realtime Fanout (`ws-fanout.js`)

- Measures WebSocket handshake, authentication token validation, heartbeat pings, and Redis pub/sub channel fan-out across concurrent client connections.
- **Measured Result:** Connection handshake p95 = **5.82ms** with 100% session success rate.
