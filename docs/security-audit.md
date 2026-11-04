# HexDispatch Security Audit & Threat Model

This document outlines the defensive security architecture, audit findings, and threat mitigations implemented across the HexDispatch microservices platform.

---

## 1. Executive Summary

HexDispatch enforces **defense-in-depth** across all architectural layers:

- **API Boundary**: Strict runtime schema enforcement via Zod (`@hexdispatch/contracts`), parameterized SQL via Drizzle ORM, and automated security header injection.
- **Authentication & RBAC**: Asymmetric JWT verification with role-based access control (`rider`, `driver`, `admin`).
- **Telemetry & Fraud Prevention**: Dedicated Trust Rules Engine detecting GPS teleportation, impossible speed anomalies, frozen mock GPS coordinates, and cancellation rate abuse.
- **Financial Integrity**: Double-entry ledger invariant assertions, PSP idempotency key guarantees, and deterministic saga recovery.
- **Dependency Hygiene**: Zero critical unmitigated vulnerabilities; automated dependency audit scanning via `pnpm audit`.

---

## 2. Threat Modeling & Surface Analysis

| Threat / Attack Vector              | Risk     | Mitigation Architecture                                                                                                                                 | Verification                                                                               |
| ----------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| **SQL Injection**                   | Critical | 100% Parameterized queries via Drizzle ORM; raw SQL concatenation strictly forbidden.                                                                   | Unit & integration test suites across core, dispatch, and payment services.                |
| **Driver Location Spoofing**        | High     | Phase 8 Trust Rules Engine analyzes velocity ($>42 \text{ m/s}$), teleport jumps ($>500 \text{ m}$), and frozen stationary reports during active trips. | `apps/location/test/trust-engine.test.ts` & `docs/benchmarks/trust-anomalies.md`           |
| **Payment Double-Spend / Replay**   | High     | Every PSP capture carries a deterministic idempotency key (`capture:<rideId>`). Payment Saga verifies existing charges before retry.                    | `apps/payment/test/saga-recovery.test.ts`                                                  |
| **Ledger Imbalance / Tampering**    | Critical | Append-only double-entry ledger. Invariant verification ($                                                                                              | \sum \text{debits} - \sum \text{credits}                                                   | = 0$) enforced after every settlement cycle. | `apps/payment/src/services/ledger-invariant.ts` |
| **Distributed State Desync**        | High     | Transactional Outbox pattern ensures atomic database mutations + Kafka event emission without 2PC deadlocks.                                            | Outbox relay background worker + chaos tests (`docs/resilience.md`).                       |
| **Brute Force / Denial of Service** | Medium   | Bounded ingest queues (`maxQueueSize = 500`) with load-shedding and 3-state Circuit Breakers (`CLOSED`, `OPEN`, `HALF_OPEN`).                           | `packages/shared/test/circuit-breaker.test.ts` & `apps/location/test/backpressure.test.ts` |

---

## 3. Defense-in-Depth Implementation Details

### 3.1 Strict Input Validation

Every HTTP endpoint and Kafka consumer validates payloads through Zod schemas defined in `@hexdispatch/contracts`:

- Request bodies are rejected with `400 Bad Request` before reaching business logic handlers.
- Unknown properties are stripped or rejected.
- String boundaries, UUID formats, and geographic coordinate ranges ($\text{lat} \in [-90, 90], \text{lng} \in [-180, 180]$) are strictly bounded.

### 3.2 Security Headers

All Fastify HTTP services instantiated via `buildServer()` in `@hexdispatch/shared` inject standard OWASP-recommended security headers on every response:

```http
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
X-XSS-Protection: 0
Strict-Transport-Security: max-age=31536000; includeSubDomains
Referrer-Policy: no-referrer
X-Request-Id: <uuid>
```

### 3.3 Environment Secrets & Isolation

- Production credentials (`JWT_SECRET`, `DATABASE_URL`, `REDIS_URL`, `KAFKA_BROKERS`, `PSP_WEBHOOK_SECRET`) are isolated via `.env` files and environment variables.
- Default secrets are provided strictly for local development and unit test execution; production deployments require secrets injected via environment managers or secret vaults.
- `.env` and `.env.local` files are ignored in `.gitignore`.

---

## 4. Automated Dependency Audit (`pnpm audit`)

As part of the Phase 9 hardening cycle, the root dependency tree was analyzed for CVE advisories:

### 4.1 Fixed Vulnerabilities

- **`tinypool` Remote Code Execution / Memory Corruption (CVE-2025-24965)**:
  - _Severity_: Critical
  - _Resolution_: Enforced `pnpm.overrides` pinning `tinypool` to `>=1.0.3` across all transitive dependencies (specifically vitest).

### 4.2 Monitored Advisories

- **`zod` Regex ReDoS / Memory Exhaustion**:
  - _Advisory_: GHSA-cqhf-9227-4527 (Affects unreleased prerelease versions `<4.6.6`).
  - _Assessment_: Low real-world risk; production code uses stable `zod@^3.24.1` with pre-compiled schemas. Production boundaries enforce strict length limits on strings preventing unbounded regex evaluation.

---

## 5. Security Checklist for Production Deployment

- [x] Strict Zod input validation on all HTTP routes and Kafka consumers.
- [x] Standard OWASP security headers enabled on all Fastify services.
- [x] Atomic driver claiming via Redis Lua scripts preventing duplicate ride assignment.
- [x] Trust Rules Engine active on driver location streams.
- [x] Cryptographic verification on payment webhooks and JWT tokens.
- [x] Double-entry accounting ledger invariants mathematically verified.
- [x] Critical vulnerabilities remediated in `package.json` overrides.
