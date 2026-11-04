-- Runs once, on first start of an empty data volume.
-- One database per service: no cross-service joins, ever.
CREATE DATABASE core;      -- identity, drivers, rides, ride_events, outbox
CREATE DATABASE dispatch;  -- offers, match_decisions
CREATE DATABASE pricing;   -- quotes, surge_history, surge_overrides
CREATE DATABASE payment;   -- payments, saga state, ledger_entries, payouts
