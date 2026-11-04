# Phase 7: Payments

**Goal:** money handling that is correct under failure.

**Estimated time:** 1 week.

**Tech used:** Fastify, PostgreSQL (`payment`), Drizzle, kafkajs, a mock PSP (separate Fastify instance or module in `apps/payment`), Vitest + Testcontainers.

## Tasks

1. Mock PSP: authorize, capture, refund endpoints; configurable latency, error rate, timeouts, duplicate callbacks, out-of-order callbacks; deterministic when seeded. Honours idempotency keys the way a real PSP does.
2. `payment` consumes `trip.state.changed` (idempotent by `eventId` and ride version): ASSIGNED -> authorize; COMPLETED -> capture the locked-quote fare; cancellations -> release or fee; refunds as compensation.
3. Idempotency keys for every PSP call, derived from `(rideId, step)`. Retries with backoff; unknown outcomes (timeouts) are resolved by querying the PSP with the same key before retrying.
4. Persisted saga state (`payment_sagas`) so a crash resumes. Compensation steps defined and tested.
5. Double-entry ledger (`ledger_entries`): accounts for rider receivable, platform revenue, driver payable, fees. A transaction posts balanced entries atomically. Invariant check: per transaction debits = credits, global sum = 0.
6. Payouts: batch driver payables into `payouts` with statements.
7. Reconciliation job: compare `psp_records` with the ledger, output a mismatch report (missing, duplicate, amount differs). `POST /admin/reconcile`.
8. Dead-letter handling and an admin retry endpoint (`POST /admin/payments/{id}/retry`).
9. Publish `payment.authorized`, `payment.captured`, `payment.failed`, `payment.refunded`.
10. Chaos test: random PSP failures, timeouts, duplicate and out-of-order callbacks over many rides.

## Acceptance criteria

1. Chaos test (fixed seed, many rides) ends with no lost and no double-captured payments (assert per ride exactly one effective capture for each completed ride).
2. Ledger invariant holds after every test run (a helper asserts it in `afterEach` of payment tests).
3. Reconciliation detects deliberately injected mismatches of each kind.
4. A crash mid-saga (test kills the consumer) resumes and completes without duplicate PSP effects.
5. Typecheck, lint, tests pass; Testcontainers integration test for `payment`.

## Out of scope

Real PSP integrations, multi-currency, tax, disputes/chargebacks, KYC, tipping.
