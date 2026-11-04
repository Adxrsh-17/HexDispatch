# HexDispatch Benchmarks

This directory contains reproducible benchmark results produced by `@hexdispatch/simulator`.
All metrics are collected using seeded, deterministic discrete-event simulation.

## Comprehensive Comparison: Greedy vs Batched Matching

See [greedy-vs-batched.md](greedy-vs-batched.md) for the full comparative study across all scenarios and seeds.

### Summary: Greedy vs Batched (Seed 42)

| Metric              | Normal (Greedy) | Normal (Batched) | Peak (Greedy) | Peak (Batched)   | Rain (Greedy) | Rain (Batched)   |
| :------------------ | :-------------- | :--------------- | :------------ | :--------------- | :------------ | :--------------- |
| **Completed Rides** | 534             | **535**          | 525           | **606 (+15.4%)** | 362           | **416 (+14.9%)** |
| **Match Rate**      | 74.4%           | **74.5%**        | 27.9%         | **32.2%**        | 31.3%         | **36.0%**        |
| **No-Driver Rate**  | 14.9%           | **1.4%**         | 66.1%         | **11.4%**        | 60.4%         | **15.8%**        |
| **Avg Pickup ETA**  | 247s (4.1m)     | 289s (4.8m)      | 323s (5.4m)   | **214s (3.6m)**  | 298s (5.0m)   | **237s (3.9m)**  |
| **p95 Pickup ETA**  | 519s (8.7m)     | 567s (9.4m)      | 574s (9.6m)   | **552s (9.2m)**  | 567s (9.4m)   | **541s (9.0m)**  |
| **Driver Util**     | 80.5%           | **88.1%**        | 92.1%         | **93.9%**        | 83.7%         | **88.6%**        |
| **Total Revenue**   | $7,542.09       | **$7,664.81**    | $7,561.91     | **$8,584.06**    | $5,070.82     | **$5,784.32**    |
| **Earnings Gini**   | 0.082           | **0.0668**       | 0.067         | **0.0639**       | 0.101         | **0.0857**       |

---

## Detailed Reports & Artifacts

### 1. Normal Scenario

- **Greedy:** [Report](normal-greedy-seed42.md) | [Data](normal-greedy-seed42.csv) | [Chart](normal-greedy-seed42-eta.svg)
- **Batched:** [Report](normal-batched-seed42.md) | [Data](normal-batched-seed42.csv) | [Chart](normal-batched-seed42-eta.svg)

### 2. Peak Scenario

- **Greedy:** [Report](peak-greedy-seed42.md) | [Data](peak-greedy-seed42.csv) | [Chart](peak-greedy-seed42-eta.svg)
- **Batched:** [Report](peak-batched-seed42.md) | [Data](peak-batched-seed42.csv) | [Chart](peak-batched-seed42-eta.svg)

### 3. Rain Scenario

- **Greedy:** [Report](rain-greedy-seed42.md) | [Data](rain-greedy-seed42.csv) | [Chart](rain-greedy-seed42-eta.svg)
- **Batched:** [Report](rain-batched-seed42.md) | [Data](rain-batched-seed42.csv) | [Chart](rain-batched-seed42-eta.svg)

---

## 4. Surge Pricing & Elasticity Benchmark

See [peak-with-vs-without-surge.md](peak-with-vs-without-surge.md) for the study comparing supply-demand dynamics under peak load with dynamic H3 surge pricing vs static pricing.

- **Match Rate Lift**: +27.4% under surge pricing
- **Driver Supply Retention**: +18.2% in surge hexes
- **Total Revenue**: +22.6% platform gross volume

---

## 5. Trust Rules & Anomaly Detection Benchmark

See [trust-anomalies.md](trust-anomalies.md) for the evaluation of the location trust engine under adversarial telemetry injection.

- **Injected Anomalies**: 93 (teleports, impossible speed $>42$ m/s, frozen ON_TRIP GPS, cancellation abuse)
- **True Positives**: 86
- **False Positives**: 0
- **Detection Rate**: **92.5%** (target $\ge 90\%$)
- **False Positive Rate**: **0.0%** (target $\le 5\%$)

---

## 6. k6 Load Testing & Throughput Benchmark

See [load-test-benchmarks.md](load-test-benchmarks.md) for the end-to-end load test results against live Fastify endpoints and WebSocket fanout.

- **Location Ingest Pings**: 96.4 rps, p50 = 1.82ms, p95 = 4.95ms (0% dropped)
- **Ride Creation**: 98.2 rps, p50 = 3.12ms, p95 = 7.84ms (100% checks passed)
- **WebSocket Driver Fanout**: 42.0 rps, p50 = 2.15ms, p95 = 5.82ms (100% delivery)
