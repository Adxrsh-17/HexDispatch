# Benchmark: PEAK Scenario (greedy)

- **Scenario:** `peak`
- **Policy:** `greedy`
- **Seed:** `42`
- **Git Commit:** `f894cf1`
- **Executed Command:** `pnpm sim --scenario peak --policy greedy --seed 42`
- **Simulation Duration:** 2 hours (7200s)
- **Timestamp:** 2026-11-04T08:15:06.403Z

## Key Metrics

| Metric                       | Value               | Target / Note               |
| ---------------------------- | ------------------- | --------------------------- |
| **Total Ride Requests**      | **1881**            | Total passenger ride demand |
| **Completed Rides**          | **525**             | Completed and paid trips    |
| **Match Rate**               | **27.9%**           | Fulfilled demand percentage |
| **No-Driver Rate**           | **66.1%**           | Unserviced requests         |
| **Pickup ETA (Average)**     | **323s** (~5.4 min) | Average wait until arrival  |
| **Pickup ETA (p95)**         | **574s** (~9.6 min) | 95th percentile worst wait  |
| **Pickup ETA (Median)**      | **331s**            | 50th percentile             |
| **Driver Utilisation**       | **92.1%**           | Time on-trip or dispatched  |
| **Avg Idle Time**            | **541s**            | Non-earning roaming time    |
| **Productivity**             | **2.19** rides/hr   | Rides per driver shift hour |
| **Total Revenue**            | **$7561.91**        | Total gross bookings        |
| **Avg Driver Earnings**      | **$63.02**          | Mean earnings per shift     |
| **Earnings Gini**            | **0.067**           | 0 = perfect equality        |
| **p90 / p10 Earnings Ratio** | **1.37x**           | Top vs bottom decile spread |
