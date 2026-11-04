# Phase 9: Hardening and showcase

**Goal:** everything a reviewer needs in five minutes.

**Estimated time:** 1 week.

**Tech used:** k6, Grafana (provisioned dashboards), Prometheus, Docker Compose, Mermaid or SVG for diagrams, `pnpm audit`, OpenAPI.

## Tasks

1. k6 load tests: ride creation, location ingest, WebSocket fan-out. Record p50/p95/p99 and throughput with command, commit and machine description.
2. Grafana dashboards (provisioned as JSON): matching latency, batch size, fallback count, surge by cell, offer acceptance, outbox lag, consumer lag, payment outcomes, ingest rate.
3. README: architecture diagram, quickstart, design decisions, trade-offs, honest limitations, phase status.
4. `docs/benchmarks.md` (or the `docs/benchmarks/` index): every scenario result, charts, seeds, and the command that reproduces it.
5. OpenAPI docs for every service, event schema docs generated from `packages/contracts`, ADR index.
6. One-command demo (`pnpm demo`): brings up infra and services, seeds data, runs a scripted flow: request a ride, watch matching, simulate a PSP failure, kill the batched matcher and show the fallback.
7. Security pass: input validation on every route, auth on every non-public route, secrets only from env, no default secrets outside dev, `pnpm audit`, dependency review, rate limits, headers (helmet), CORS policy.
8. Reproducibility audit: every number in README and docs is traced to a command and seed; remove or re-measure anything that is not.
9. Optional: short recorded demo video.

## Acceptance criteria

1. A new reader can run the demo from the README with one command.
2. Every number in the README can be reproduced with a documented command (audit checklist committed).
3. Dashboards load with data after the demo run.
4. `pnpm audit` has no unaddressed high/critical findings, or each is documented with a reason.
5. All earlier phases' tests still pass in CI.

## Out of scope

New features. Kubernetes manifests (optional extra). Cloud deployment.
