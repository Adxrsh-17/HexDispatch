# HexDispatch

A ride-sharing dispatch backend built as microservices. The point is the dispatch engine, not CRUD:

- **Batched matching:** requests are collected in ~2 s windows per H3 region and matched by solving a minimum-cost assignment, instead of greedy nearest-driver.
- **Geo-sharded matchers:** H3 cells partition the city; atomic Redis claims resolve border conflicts.
- **Surge as a control loop:** EWMA, clamp, step limit, hysteresis, neighbour blending.
- **Idempotent payments saga:** double-entry ledger, mock PSP, reconciliation.
- **Seeded city simulator:** runs the same matching code as production and compares greedy vs batched. Results are reproducible and only measured numbers are reported.

Status: **scaffold only**. No feature phase is implemented yet.

## Quickstart

Requirements: Node >= 22 (see `.nvmrc`), pnpm 9, Docker (for infra and integration tests).

```bash
pnpm install
pnpm test          # unit tests (GreedyPolicy, shared, contracts)
pnpm typecheck
pnpm lint
pnpm dev           # starts all six apps; each answers GET /health
```

```bash
pnpm infra:up      # postgres 16, redis 7, redpanda (localhost:19092), prometheus :9090, grafana :3030
pnpm infra:down
```

| App      | Port |
| -------- | ---- |
| gateway  | 3000 |
| core-api | 3001 |
| location | 3002 |
| dispatch | 3003 |
| pricing  | 3004 |
| payment  | 3005 |

Copy `.env.example` to `.env` to override defaults (apps work without it).

## Docs

- [CLAUDE.md](CLAUDE.md): project rules and working agreement
- [docs/PROJECT_PLAN.md](docs/PROJECT_PLAN.md): design
- [docs/TECH_STACK.md](docs/TECH_STACK.md): stack choices
- [docs/adr/](docs/adr/): decisions
- [docs/phases/](docs/phases/): one spec per phase

## Building a phase

In Claude Code, run `/phase N` (for example `/phase 0`). One phase at a time; the next starts only when every acceptance criterion is demonstrated.

## Phase status

- [x] Scaffold (workspace, `buildServer`, GreedyPolicy, docs, infra files)
- [ ] Phase 0: Foundations
- [x] Phase 1: Core API
- [x] Phase 2: Location and realtime
- [x] Phase 3: Baseline dispatch
- [x] Phase 4: City simulator
- [x] Phase 5: Batched matching
- [x] Phase 6: Pricing and surge
- [ ] Phase 7: Payments
- [ ] Phase 8: Trust and resilience (stretch)
- [ ] Phase 9: Hardening and showcase

## Benchmarks

Benchmark results from `@hexdispatch/simulator` are located in [`docs/benchmarks/`](docs/benchmarks/README.md).

- Baseline greedy benchmarks: `normal`, `peak`, and `rain` scenarios.
