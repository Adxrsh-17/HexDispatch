# Load test results (smoke-scale, in-process)

> **How to read this.** Each run is a few seconds long with 10 constant virtual users against in-process servers backed by PGlite and an in-memory Redis, on a development laptop. "Throughput" is how fast 10 looping users finished requests, not a capacity limit. Nothing here was measured against real Postgres, Redis or Kafka. Do not quote these as service capacity.
>
> Every number is parsed from the raw k6 summaries in `docs/benchmarks/raw/`. The report generator fails if a metric is missing; it has no fallback values.

- **Date:** 2026-11-06T12:09:01.224Z
- **Git commit:** `aa608aa`
- **Machine:** Windows_NT x64 | AMD Ryzen 7 7435HS (16 logical CPUs) | 25.4 GB RAM
- **k6:** k6.exe v2.3.0 (commit/e088784614, go1.26.8, windows/amd64)
- **Command:** `pnpm bench:load`

| Workflow                                              | Script              | Requests / sessions | Per second | Failed | p50 (ms) | p95 (ms) | p99 (ms) | Notes                              |
| :---------------------------------------------------- | :------------------ | ------------------: | ---------: | -----: | -------: | -------: | -------: | :--------------------------------- |
| Location ping ingest (POST /drivers/me/location)      | `location-pings.js` |                 475 |      93.21 |      0 |     3.63 |        9 |    90.48 | k6 exit code 0                     |
| Ride creation + outbox row (POST /rides, PGlite)      | `ride-creation.js`  |                 607 |     119.68 |      0 |     29.2 |    53.06 |    73.95 | k6 exit code 0                     |
| WebSocket connect + authenticated ping/pong (gateway) | `ws-fanout.js`      |                  30 |       4.96 |    n/a |        5 |    27.55 |    28.71 | pongs received: 30; k6 exit code 0 |

The WebSocket row measures connection setup (handshake and token verification) and one ping/pong round trip per session. It does not measure room fan-out.
