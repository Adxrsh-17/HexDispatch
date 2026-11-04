# Phase 0: Foundations

**Goal:** a monorepo where any service can be added, run, observed and tested.

**Estimated time:** 2-3 days.

**Tech used:** pnpm, TypeScript, Fastify, pino, prom-client, OpenTelemetry (SDK + OTLP), kafkajs, Redpanda, Docker Compose, Prometheus, Grafana, Vitest, Testcontainers, GitHub Actions.

Already done by the scaffold: workspace layout, `buildServer()` with `/health` `/ready` `/metrics`, env config, logger, `AppError`, `contracts`, `matching` + GreedyPolicy, compose file, CI skeleton. This phase finishes the rest.

## Tasks

1. Verify `pnpm infra:up` brings up postgres, redis, redpanda, prometheus, grafana healthy; fix anything that does not. Add an OpenTelemetry collector service to compose (OTLP in, Prometheus/logging out) if traces need it.
2. Add OpenTelemetry to `buildServer()` (opt-in via `OTEL_EXPORTER_OTLP_ENDPOINT`): HTTP server spans, trace id in logs, `x-request-id` as the correlation id on spans.
3. Wire Prometheus scraping of all six apps (already configured) and confirm one app's metrics appear in Grafana via a provisioned starter dashboard.
4. `packages/shared` Kafka wrapper (kafkajs): typed producer (idempotent, keyed, batch), consumer with retry + exponential backoff, dead-letter publish to `dlq.<group>`, graceful shutdown, metrics (`kafka_messages_total`, `kafka_consume_errors_total`, `kafka_dlq_total`).
5. `packages/shared` idempotency helper skeleton: processed-event guard interface (Postgres implementation arrives in Phase 1).
6. Add Drizzle + drizzle-kit setup per database with a `db:migrate` script pattern (one migrations folder per service). No tables yet.
7. Testcontainers helper in `packages/shared/testing` to start Postgres, Redis and Redpanda for tests.
8. Finish CI: install, typecheck, lint, format:check, test (Docker available on the runner).
9. ADRs for any new non-obvious decision (for example tracing exporter choice, Kafka retry policy).

## Acceptance criteria

1. `pnpm infra:up` starts all containers healthy; `pnpm infra:down` stops them.
2. A sample service shows a trace and a metric in Grafana/Prometheus (documented screenshot or query output, plus the steps to reproduce).
3. A Testcontainers test publishes and consumes a message through the shared wrapper, including a retry-then-DLQ case.
4. CI passes on a fresh clone.
5. `pnpm typecheck`, `pnpm lint`, `pnpm test` pass.

## Out of scope

Any business logic: auth, rides, dispatch, pricing, payments. Database tables. WebSockets. Hungarian solver.
