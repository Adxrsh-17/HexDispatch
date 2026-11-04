# HexDispatch

Ride-sharing dispatch backend (microservices). Not a CRUD clone. The centrepiece:

1. **Batched matching.** Collect ride requests in ~2 s windows per H3 region and solve a minimum-cost assignment (Hungarian / min-cost flow) instead of greedy nearest-driver.
2. **Geo-sharding.** City split into H3 cells (res 8 for surge/matching cells, res 6-7 for matcher ownership). Atomic driver claims resolve border conflicts.
3. **Surge as a control loop.** EWMA smoothing, clamp, per-step change limit, hysteresis, neighbour blending.
4. **Idempotent payments saga.** Double-entry ledger, mock PSP, reconciliation.
5. **Seeded city simulator.** Runs the SAME `packages/matching` code as production; compares greedy against batched. Results are reproducible and honestly reported.

Full design: [docs/PROJECT_PLAN.md](docs/PROJECT_PLAN.md). Stack reasons: [docs/TECH_STACK.md](docs/TECH_STACK.md). Per-phase specs: `docs/phases/PHASE-N.md`.

## Fixed tech decisions

Do not change without writing an ADR in `docs/adr/`.

- TypeScript strict, Node >= 22, pnpm workspaces, ESM, tsx for dev, Vitest + Testcontainers, ESLint (flat config) + Prettier.
- Fastify 5 + zod for HTTP and validation; `@fastify/websocket` for WebSockets.
- PostgreSQL 16 only (no MongoDB). Drizzle ORM + drizzle-kit migrations. Schema-per-service, separate databases: `core`, `dispatch`, `pricing`, `payment`.
- Redis 7 via ioredis (H3 cell sets, driver hashes, Lua scripts for atomic claims, pub/sub fan-out).
- Kafka API via Redpanda (kafkajs). Host access `localhost:19092`.
- `h3-js` for geo. `pino` logs, `prom-client` metrics, OpenTelemetry traces.
- k6 for load tests. GitHub Actions for CI.

## Repo layout

```
apps/gateway     :3000  REST proxy, JWT verify, rate limit, WebSocket gateway
apps/core-api   :3001  identity, drivers, rides, trip state machine, transactional outbox
apps/location   :3002  driver pings, H3 driver index
apps/dispatch   :3003  offers, baseline policy, batched policy
apps/pricing    :3004  quotes, surge
apps/payment    :3005  saga, ledger, mock PSP
packages/shared        env config (zod), pino logger, AppError, buildServer(); Kafka + idempotency helpers come in Phase 0/1
packages/contracts     Kafka topic names, event zod schemas, TripState + transition table types
packages/matching      PURE: types, haversine, MatchingPolicy, GreedyPolicy (Hungarian in Phase 5). No I/O.
tools/simulator        city simulator (stub until Phase 4)
tools/load-tests       k6 scripts
infra/                 docker-compose, postgres init, prometheus, grafana
docs/                  PROJECT_PLAN, TECH_STACK, adr/, phases/, benchmarks/
```

Workspace packages export TypeScript source (`main`/`types` -> `src/index.ts`). There is no build step in dev.

## Commands

```bash
pnpm install
pnpm dev            # all six apps (ports 3000-3005)
pnpm typecheck      # tsc --noEmit in every package
pnpm lint           # eslint .
pnpm format         # prettier --write .   (format:check in CI)
pnpm test           # vitest run, whole repo
pnpm infra:up       # postgres, redis, redpanda, prometheus, grafana
pnpm infra:down
pnpm sim --scenario peak --policy greedy --seed 42   # Phase 4+
```

## Coding rules

- Strict TypeScript. No untyped `any`; if unavoidable, add `// eslint-disable-next-line @typescript-eslint/no-explicit-any -- <reason>`.
- Config only from environment variables, validated with zod at boot (`loadEnv`, `loadServiceEnv`). Document every new var in `.env.example`.
- `packages/matching` stays pure: no I/O, no `Date.now()`, no `Math.random()`. Time and randomness are injected.
- Every service uses `buildServer()` so it gets `/health`, `/ready`, `/metrics`, correlation ids and uniform errors.
- Validate every external input with zod. Errors thrown to clients are `AppError`.
- Kafka topic names and event schemas live only in `packages/contracts`.
- No cross-service database access. Services talk through HTTP or Kafka.
- Trip state changes go through the single transition table. Nothing else writes `rides.status`.

## Definition of done (per phase)

- Every acceptance criterion in the phase file is demonstrated by a test or a script, not by assertion.
- `pnpm typecheck`, `pnpm lint`, `pnpm test` pass; `format:check` passes.
- Each touched service has unit tests and at least one Testcontainers integration test.
- Metrics and traces for new code exist.
- `docker compose` still works (`pnpm infra:up`).
- Docs updated; an ADR exists for each non-obvious decision.
- README phase checklist ticked.
- Final report lists each acceptance criterion with its evidence, plus assumptions and anything incomplete.

## Working agreement

- One phase at a time. Do not start the next until all acceptance criteria are demonstrated by tests or scripts.
- Strict TypeScript, no untyped `any` without a comment, config only via env.
- Every side effect (Kafka publish, HTTP call, payment) is idempotent or guarded by an idempotency key.
- Tests per service, including at least one Testcontainers integration test.
- Metrics and traces are added as you build, not at the end.
- ADR for every non-obvious decision. Small, clear commits. `docker compose` must keep working.
- Never invent benchmark numbers. Record only measured results, with the command and seed used.
- If something is ambiguous, state the assumption in the docs and continue.
