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
