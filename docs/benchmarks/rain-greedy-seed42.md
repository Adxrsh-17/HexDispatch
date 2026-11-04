# Benchmark: RAIN Scenario (greedy)

- **Scenario:** `rain`
- **Policy:** `greedy`
- **Seed:** `42`
- **Git Commit:** `f894cf1`
- **Executed Command:** `pnpm sim --scenario rain --policy greedy --seed 42`
- **Simulation Duration:** 2 hours (7200s)
- **Timestamp:** 2026-11-04T08:15:16.303Z

## Key Metrics

| Metric                       | Value               | Target / Note               |
| ---------------------------- | ------------------- | --------------------------- |
| **Total Ride Requests**      | **1155**            | Total passenger ride demand |
| **Completed Rides**          | **362**             | Completed and paid trips    |
| **Match Rate**               | **31.3%**           | Fulfilled demand percentage |
| **No-Driver Rate**           | **60.4%**           | Unserviced requests         |
| **Pickup ETA (Average)**     | **298s** (~5.0 min) | Average wait until arrival  |
| **Pickup ETA (p95)**         | **567s** (~9.4 min) | 95th percentile worst wait  |
| **Pickup ETA (Median)**      | **288s**            | 50th percentile             |
| **Driver Utilisation**       | **83.7%**           | Time on-trip or dispatched  |
| **Avg Idle Time**            | **1144s**           | Non-earning roaming time    |
| **Productivity**             | **1.81** rides/hr   | Rides per driver shift hour |
| **Total Revenue**            | **$5070.82**        | Total gross bookings        |
| **Avg Driver Earnings**      | **$50.71**          | Mean earnings per shift     |
| **Earnings Gini**            | **0.1011**          | 0 = perfect equality        |
| **p90 / p10 Earnings Ratio** | **1.59x**           | Top vs bottom decile spread |
