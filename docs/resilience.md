# HexDispatch Failure Injection Report

**Generated:** 2026-11-06T12:02:27.556Z
**Command:** `pnpm chaos`

## What this report is, and is not

- **Measured** means one thing: the time from `docker stop` of a dependency container until its health probe passes again after `docker start`. That is infrastructure recovery time.
- **Not measured:** how HexDispatch services behave during the outage, and whether any data is lost. The "Expected behaviour" column is design intent taken from the code, not an observation. Backing it with assertions against running services is open work.
- A scenario that cannot run says **NOT RUN** and gives the reason. This runner never fabricates a number. (An earlier version did: it slept for a fixed time when Docker was absent and reported that as a recovery time. Those figures were removed.)

## Results

| Scenario        | Target                                  | Container recovery                                                                                                                                                                              | Expected behaviour (design intent, not observed)                                                                                              |
| :-------------- | :-------------------------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------- |
| `kill-redis`    | Redis 7 (driver index, claims, pub/sub) | NOT RUN (Docker is not available on this machine)                                                                                                                                               | Driver claims fail (claims never fall back to a non-atomic path); location index repopulates from pings; trips and payments live in Postgres. |
| `kill-kafka`    | Redpanda (Kafka API, localhost:19092)   | NOT RUN (Docker is not available on this machine)                                                                                                                                               | Events stay in the core-api outbox (published_at NULL) and the relay drains them after reconnect; consumers dedupe by eventId.                |
| `kill-dispatch` | dispatch service (:3003)                | NOT RUN (apps run as host processes (pnpm dev), not containers; no kill harness exists yet. Restart behaviour is covered by apps/dispatch/test/recovery.test.ts and hardening.test.ts instead.) | Pending offers re-arm from Postgres; MATCHING rides are re-read from core-api on boot.                                                        |
| `kill-gateway`  | gateway (:3000)                         | NOT RUN (apps run as host processes (pnpm dev), not containers; no kill harness exists yet.)                                                                                                    | Clients reconnect with lastEventId and replay missed events from the Redis stream.                                                            |

## Where restart and failure behaviour is actually tested

These are automated tests in the repository, run with `pnpm test` (in-process, on PGlite and an in-memory Redis, not on real containers):

- Offer accept/decline/expire races, core-api refusal handling, claim atomicity: `apps/dispatch/test/hardening.test.ts`
- Dispatch restart with a pending offer: `apps/dispatch/test/recovery.test.ts`
- Dispatch restart with pending (not yet offered) rides, solver failure and slow-solve fallback: `apps/dispatch/test/hardening.test.ts`
- Payment saga resume after a crash mid-step: `apps/payment/test/saga-recovery.test.ts`
- Outbox relay: `apps/core-api/test/outbox-relay.test.ts`

## Not yet tested against real infrastructure

Real Postgres, Redis and Kafka failure behaviour. The `*.testcontainers.test.ts` suites exist but need Docker.
