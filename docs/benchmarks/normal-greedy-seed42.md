# Benchmark: NORMAL Scenario (greedy)

- **Scenario:** `normal`
- **Policy:** `greedy`
- **Seed:** `42`
- **Git Commit:** `f894cf1`
- **Executed Command:** `pnpm sim --scenario normal --policy greedy --seed 42`
- **Simulation Duration:** 2 hours (7200s)
- **Timestamp:** 2026-11-04T08:14:45.899Z

## Key Metrics

| Metric                       | Value               | Target / Note               |
| ---------------------------- | ------------------- | --------------------------- |
| **Total Ride Requests**      | **718**             | Total passenger ride demand |
| **Completed Rides**          | **534**             | Completed and paid trips    |
| **Match Rate**               | **74.4%**           | Fulfilled demand percentage |
| **No-Driver Rate**           | **14.9%**           | Unserviced requests         |
| **Pickup ETA (Average)**     | **247s** (~4.1 min) | Average wait until arrival  |
| **Pickup ETA (p95)**         | **519s** (~8.7 min) | 95th percentile worst wait  |
| **Pickup ETA (Median)**      | **221s**            | 50th percentile             |
| **Driver Utilisation**       | **80.5%**           | Time on-trip or dispatched  |
| **Avg Idle Time**            | **1372s**           | Non-earning roaming time    |
| **Productivity**             | **2.67** rides/hr   | Rides per driver shift hour |
| **Total Revenue**            | **$7542.09**        | Total gross bookings        |
| **Avg Driver Earnings**      | **$75.42**          | Mean earnings per shift     |
| **Earnings Gini**            | **0.082**           | 0 = perfect equality        |
| **p90 / p10 Earnings Ratio** | **1.42x**           | Top vs bottom decile spread |
