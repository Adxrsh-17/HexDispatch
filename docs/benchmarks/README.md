# HexDispatch Benchmarks

This directory contains reproducible benchmark results produced by `@hexdispatch/simulator`.
All metrics are collected using seeded, deterministic discrete-event simulation.

## Baseline Dispatch Comparison (Phase 4: Greedy Policy)

| Metric                  | Normal Scenario    | Peak Scenario      | Rain Scenario      |
| ----------------------- | ------------------ | ------------------ | ------------------ |
| **Demand (Requests)**   | 718                | 1,881              | 1,155              |
| **Active Drivers**      | 100                | 120                | 100                |
| **Completed Rides**     | 534                | 525                | 362                |
| **Match Rate**          | **74.4%**          | **27.9%**          | **31.3%**          |
| **No-Driver Rate**      | 14.9%              | 66.1%              | 60.4%              |
| **Avg Pickup ETA**      | **247s (4.1 min)** | **323s (5.4 min)** | **298s (5.0 min)** |
| **p95 Pickup ETA**      | **519s (8.7 min)** | **574s (9.6 min)** | **567s (9.4 min)** |
| **Driver Utilisation**  | 80.5%              | 92.1%              | 83.7%              |
| **Productivity**        | 2.67 rides/hr      | 2.19 rides/hr      | 1.81 rides/hr      |
| **Total Revenue**       | $7,542.09          | $7,561.91          | $5,070.82          |
| **Avg Driver Earnings** | $75.42             | $63.02             | $50.71             |
| **Earnings Gini**       | 0.082              | 0.067              | 0.101              |
| **p90 / p10 Spread**    | 1.42x              | 1.37x              | 1.59x              |

---

## Detailed Reports & Artifacts

### 1. Normal Scenario

- **Command:** `pnpm sim --scenario normal --policy greedy --seed 42`
- **Markdown Report:** [normal-greedy-seed42.md](normal-greedy-seed42.md)
- **Driver Dataset (CSV):** [normal-greedy-seed42.csv](normal-greedy-seed42.csv)
- **Pickup ETA Distribution (SVG):** [normal-greedy-seed42-eta.svg](normal-greedy-seed42-eta.svg)

### 2. Peak Scenario

- **Command:** `pnpm sim --scenario peak --policy greedy --seed 42`
- **Markdown Report:** [peak-greedy-seed42.md](peak-greedy-seed42.md)
- **Driver Dataset (CSV):** [peak-greedy-seed42.csv](peak-greedy-seed42.csv)
- **Pickup ETA Distribution (SVG):** [peak-greedy-seed42-eta.svg](peak-greedy-seed42-eta.svg)

### 3. Rain Scenario

- **Command:** `pnpm sim --scenario rain --policy greedy --seed 42`
- **Markdown Report:** [rain-greedy-seed42.md](rain-greedy-seed42.md)
- **Driver Dataset (CSV):** [rain-greedy-seed42.csv](rain-greedy-seed42.csv)
- **Pickup ETA Distribution (SVG):** [rain-greedy-seed42-eta.svg](rain-greedy-seed42-eta.svg)
