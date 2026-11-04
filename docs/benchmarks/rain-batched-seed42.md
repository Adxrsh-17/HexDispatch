# Benchmark: RAIN Scenario (batched)

- **Scenario:** `rain`
- **Policy:** `batched`
- **Seed:** `42`
- **Git Commit:** `32a8419`
- **Executed Command:** `pnpm sim --scenario rain --policy batched --seed 42`
- **Simulation Duration:** 2 hours (7200s)
- **Timestamp:** 2026-11-04T11:08:53.187Z

## Key Metrics

| Metric                       | Value               | Target / Note               |
| ---------------------------- | ------------------- | --------------------------- |
| **Total Ride Requests**      | **1155**            | Total passenger ride demand |
| **Completed Rides**          | **416**             | Completed and paid trips    |
| **Match Rate**               | **36.0%**           | Fulfilled demand percentage |
| **No-Driver Rate**           | **15.8%**           | Unserviced requests         |
| **Pickup ETA (Average)**     | **237s** (~3.9 min) | Average wait until arrival  |
| **Pickup ETA (p95)**         | **541s** (~9.0 min) | 95th percentile worst wait  |
| **Pickup ETA (Median)**      | **204s**            | 50th percentile             |
| **Driver Utilisation**       | **88.6%**           | Time on-trip or dispatched  |
| **Avg Idle Time**            | **794s**            | Non-earning roaming time    |
| **Productivity**             | **2.08** rides/hr   | Rides per driver shift hour |
| **Total Revenue**            | **$5784.32**        | Total gross bookings        |
| **Avg Driver Earnings**      | **$57.84**          | Mean earnings per shift     |
| **Earnings Gini**            | **0.0857**          | 0 = perfect equality        |
| **p90 / p10 Earnings Ratio** | **1.45x**           | Top vs bottom decile spread |
