# ADR 0008: Idempotent Payments Saga and Double-Entry Ledger

- Status: Accepted
- Date: 2026-11-04

## Context

Financial transactions in distributed ride-hailing systems operate over unreliable external payment networks (PSPs) and asynchronous event streams (Kafka). Under high load, networks drop connections, PSPs timeout, messages are delivered more than once, and processes crash mid-operation.

A naive payment implementation risks:

1. Double-capturing riders' credit cards when retrying timed-out API calls.
2. Silent payment loss if a service crashes between Kafka consumption and PSP settlement.
3. Accounting drift where company balance sheets, driver earnings, and PSP receipts do not balance.

We require a resilient, idempotent payment architecture that guarantees zero lost and zero double-captured payments, survives mid-saga crashes, and enforces strict double-entry ledger invariants.

## Alternatives Considered

1. **Two-Phase Commit (2PC) / Distributed Transactions:**
   - _Rejected:_ External PSPs (Stripe, Adyen, Razorpay) do not participate in XA/2PC protocols. Distributed locking across external networks introduces high latency and cascading failure modes.
2. **Simple Transaction Table (Single-Entry):**
   - Storing a single balance or status column per ride.
   - _Rejected:_ Single-entry bookkeeping cannot trace where money flowed, cannot balance platform fees against driver liabilities, and fails financial audit standards.
3. **Choreographed / Orchestrated Saga with Double-Entry Ledger:**
   - _Accepted:_ Event-driven saga persisted in PostgreSQL (`payment_sagas`), with deterministic idempotency keys, query-before-retry timeout resolution, and balanced double-entry accounting (`ledger_entries`).

## Decision

1. **Persisted Saga Orchestration (`apps/payment/src/services/payment-saga.ts`):**
   - Each ride's payment lifecycle is modeled as an explicit state machine:
     - `ASSIGNED` -> `AUTHORIZE`: places hold on estimated quoted fare.
     - `COMPLETED` -> `CAPTURE`: captures final locked-quote fare and posts ledger settlement.
     - `CANCELLED_*` -> `RELEASE`: releases authorization hold, or captures cancellation fee if eligible.
     - `REFUND` -> `REFUND`: compensating transaction reversing passenger charge, driver payable, and platform fee.
   - Saga state is persisted in `payment_sagas(ride_id, step, state, attempts, max_attempts, payload, last_error)` before any external call.
   - Consumers resuming after a crash execute `resumePendingSagas()`, resolving in-flight states using deterministic idempotency keys.

2. **Deterministic Idempotency & Timeout Resolution:**
   - Every external PSP call carries a deterministic idempotency key derived from `(step, rideId)`:
     - `auth:${rideId}`
     - `capture:${rideId}`
     - `release:${rideId}`
     - `refund:${rideId}`
   - When a PSP request times out (`ETIMEDOUT`), the saga does not blindly retry; it queries the PSP using `queryByIdempotencyKey(key)`. If the PSP already executed the operation, the result is captured without repeating the charge.

3. **Double-Entry Ledger (`apps/payment/src/ledger/double-entry.ts`):**
   - All monetary movements are recorded in `ledger_entries(id, txn_id, account, debit, credit, ts)`.
   - Chart of Accounts:
     - `rider_receivable` (Asset): debited when fare is captured, credited on refund.
     - `driver_payable` (Liability): credited with driver share ($80\%$), debited upon payout.
     - `platform_revenue` (Revenue): credited with platform take rate ($20\%$).
     - `cash_clearing` (Asset): balancing account for PSP settlements and bank payouts.
   - Invariant:
     - For every transaction, $\sum \text{debits} = \sum \text{credits}$.
     - Global ledger balance: $\sum \text{debit} - \sum \text{credit} = 0$.
     - Enforced via `assertLedgerInvariant(db)` after every test run.

4. **Automated Reconciliation (`apps/payment/src/services/reconciliation.ts`):**
   - `POST /admin/reconcile` compares internal `ledger_entries` against external `psp_records`.
   - Detects and categorizes:
     1. `MISSING_IN_LEDGER`
     2. `MISSING_IN_PSP`
     3. `AMOUNT_MISMATCH`
     4. `DUPLICATE_PSP_RECORD`

5. **Dead-Letter Queue & Admin Controls:**
   - Sagas exceeding 5 attempts are marked `FAILED` and published to `dlq.payment`.
   - Admin operators can inspect payment status (`GET /rides/:id/payment`) and force retries (`POST /admin/payments/:id/retry`).

## Consequences

- **Financial Safety:** Verified via multi-ride chaos testing under high simulated network timeout rates ($25\%$), resulting in 0 lost payments and 0 duplicate captures.
- **Auditability:** Every rupee/cent is traceable to a balanced transaction and immutable PSP reference.
- **Crash Recovery:** Consumers can be terminated mid-operation and will cleanly resume on restart without side effects.
