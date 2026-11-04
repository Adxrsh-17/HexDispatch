# Benchmark: NORMAL Scenario (batched)

- **Scenario:** `normal`
- **Policy:** `batched`
- **Seed:** `42`
- **Git Commit:** `32a8419`
- **Executed Command:** `pnpm sim --scenario normal --policy batched --seed 42`
- **Simulation Duration:** 2 hours (7200s)
- **Timestamp:** 2026-11-04T11:08:33.328Z

## Key Metrics

| Metric                       | Value               | Target / Note               |
| ---------------------------- | ------------------- | --------------------------- |
| **Total Ride Requests**      | **718**             | Total passenger ride demand |
| **Completed Rides**          | **535**             | Completed and paid trips    |
| **Match Rate**               | **74.5%**           | Fulfilled demand percentage |
| **No-Driver Rate**           | **1.4%**            | Unserviced requests         |
| **Pickup ETA (Average)**     | **289s** (~4.8 min) | Average wait until arrival  |
| **Pickup ETA (p95)**         | **567s** (~9.4 min) | 95th percentile worst wait  |
| **Pickup ETA (Median)**      | **275s**            | 50th percentile             |
| **Driver Utilisation**       | **88.1%**           | Time on-trip or dispatched  |
| **Avg Idle Time**            | **823s**            | Non-earning roaming time    |
| **Productivity**             | **2.67** rides/hr   | Rides per driver shift hour |
| **Total Revenue**            | **$7664.81**        | Total gross bookings        |
| **Avg Driver Earnings**      | **$76.65**          | Mean earnings per shift     |
| **Earnings Gini**            | **0.0668**          | 0 = perfect equality        |
| **p90 / p10 Earnings Ratio** | **1.36x**           | Top vs bottom decile spread |
