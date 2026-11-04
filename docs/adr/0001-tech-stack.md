# ADR 0001: Tech stack and service layout

- Status: Accepted
- Date: 2026-11-04

## Context

HexDispatch needs one codebase that contains several services, a pure matching library reused by a simulator, and real infrastructure (Postgres, Redis, Kafka) in tests. The original DispatchIQ plan left several choices open (NestJS or Express, Socket.IO or ws, Node 20+) and listed eight apps.

## Decision

- TypeScript strict, Node >= 22, pnpm workspaces, ESM, tsx, Vitest + Testcontainers, ESLint flat config, Prettier.
- Fastify 5 + zod; `@fastify/websocket`.
- PostgreSQL 16 only, Drizzle ORM, one database per service (`core`, `dispatch`, `pricing`, `payment`).
- Redis 7 (ioredis), Kafka API via Redpanda (kafkajs, host port 19092).
- h3-js, pino, prom-client, OpenTelemetry, k6, GitHub Actions.
- Six apps: `gateway`, `core-api`, `location`, `dispatch`, `pricing`, `payment`. Identity and Trip are merged into `core-api`; the realtime WebSocket gateway lives in `gateway`.
- Workspace packages expose TypeScript source (`main`/`types` -> `src/index.ts`); no build step in development.
- `packages/matching` is pure so production and the simulator run identical code.

## Consequences

- Fewer deployables (6 vs 8) and fewer network hops on the ride-creation path, at the cost of a larger `core-api`. Identity and trips share the `core` database, which also allows one transaction for ride + outbox + idempotency key.
- The WebSocket gateway scales with the REST gateway; multi-node fan-out uses Redis pub/sub.
- No build step means production images need either tsx or a later build pipeline. Acceptable: this is a showcase project; revisit in Phase 9 if needed.
- Changing any item above needs a new ADR that supersedes this one.

## Alternatives considered

See the "Rejected" column in [TECH_STACK.md](../TECH_STACK.md).
