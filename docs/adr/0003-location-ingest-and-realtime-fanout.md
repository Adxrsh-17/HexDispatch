# ADR 0003: Location Ingest, Driver Spatial Index, and Realtime Fan-out

- Status: Accepted
- Date: 2026-11-04

## Context

Phase 2 requires ingesting high-frequency driver telemetry (GPS coordinates, heading, speed, status) at scale, keeping an up-to-date spatial index for dispatch queries, streaming telemetry to riders and matching consumers, and ensuring high availability across multiple gateway instances. Key architectural challenges:

1. **Spatial Invariant:** When drivers move across H3 cell boundaries, race conditions or split-brain indexing could result in a driver being in zero cells (lost driver) or multiple cells (duplicate dispatch).
2. **High Ingest Throughput vs Broker Load:** Individual network calls to Kafka for each location ping (e.g., thousands of pings per second) would introduce severe overhead and queue contention.
3. **Multi-Node Realtime Streaming:** Riders and drivers connect to different gateway nodes; an update ingested on any node must reliably reach subscribers regardless of which node holds their WebSocket connection.
4. **Transient Disconnects & Replay:** Mobile clients frequently experience network drops; reconnecting clients must resume their event stream without missing updates or receiving duplicates.

## Decision

1. **Redis Driver Hash & Atomic Lua Cell Migration:**
   - Driver state is maintained in `driver:{id}` with an automatic TTL (default 30s) to discard stale or disconnected drivers.
   - Spatial sets `cell:{h3}:drivers` group drivers by H3 cell resolution 8.
   - An atomic Lua script (`LUA_UPDATE_LOCATION`) handles cell transitions: it reads the previous cell, executes `SREM` on the old cell, and `SADD` on the new cell within a single atomic Redis transaction. This guarantees the driver appears in exactly one cell set at all times.

2. **K-Ring Expanding Spatial Search:**
   - `NearbySearch` uses Uber's H3 `gridDisk` algorithm to query concentric hexagonal rings outward from the pickup coordinate.
   - Searches expand ring-by-ring until `limit` candidates are collected or `maxRadiusKm` is reached.
   - Candidates are ranked by exact spherical distance via the Haversine formula, property-tested against brute-force searches across randomised data.

3. **Kafka Batch Publisher:**
   - Telemetry events (`location.updated`) are batched in-memory by `LocationBatchPublisher` and flushed either upon reaching `batchSize` (default 50) or when `flushIntervalMs` (default 200ms) elapses.
   - Messages are partitioned with `key = driverId`, ensuring sequential delivery per driver across Kafka partition consumer groups.

4. **Multi-Node Gateway WebSocket Fan-Out and Stream Replay:**
   - The Gateway WebSocket endpoint (`/ws`) authenticates connections via JWT tokens and supports room subscription (`ride:{id}`).
   - Multi-node fan-out uses Redis Pub/Sub channels (`pubsub:room:{id}`): when an update is broadcast on any gateway instance, all peer nodes receive and fan out the update to locally connected WebSocket clients.
   - Every broadcast is recorded in a bounded Redis Stream (`stream:room:{id}`, `MAXLEN ~ 200`). When clients reconnect with `lastEventId`, the gateway queries stream entries after that ID to replay missed events without gaps or duplicates.
   - A real-time tracking demo is served at `/demo` with Leaflet.js map visualization and live telemetry event logging.

## Consequences

- Spatial index state is ephemeral, self-healing, and consistent under high-speed driver movement.
- Kafka producer overhead is bounded through micro-batching without sacrificing low-latency event delivery.
- Horizontal scaling of Gateway WebSocket nodes is trivial, with zero inter-node coupling beyond Redis Pub/Sub and Streams.
- Reconnection logic protects mobile clients from packet loss and network interruptions.
