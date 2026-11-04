# Benchmark: PEAK Scenario (batched)

- **Scenario:** `peak`
- **Policy:** `batched`
- **Seed:** `42`
- **Git Commit:** `32a8419`
- **Executed Command:** `pnpm sim --scenario peak --policy batched --seed 42`
- **Simulation Duration:** 2 hours (7200s)
- **Timestamp:** 2026-11-04T11:08:41.865Z

## Key Metrics

| Metric                       | Value               | Target / Note               |
| ---------------------------- | ------------------- | --------------------------- |
| **Total Ride Requests**      | **1881**            | Total passenger ride demand |
| **Completed Rides**          | **606**             | Completed and paid trips    |
| **Match Rate**               | **32.2%**           | Fulfilled demand percentage |
| **No-Driver Rate**           | **11.4%**           | Unserviced requests         |
| **Pickup ETA (Average)**     | **214s** (~3.6 min) | Average wait until arrival  |
| **Pickup ETA (p95)**         | **552s** (~9.2 min) | 95th percentile worst wait  |
| **Pickup ETA (Median)**      | **151s**            | 50th percentile             |
| **Driver Utilisation**       | **93.9%**           | Time on-trip or dispatched  |
| **Avg Idle Time**            | **406s**            | Non-earning roaming time    |
| **Productivity**             | **2.52** rides/hr   | Rides per driver shift hour |
| **Total Revenue**            | **$8584.06**        | Total gross bookings        |
| **Avg Driver Earnings**      | **$71.53**          | Mean earnings per shift     |
| **Earnings Gini**            | **0.0639**          | 0 = perfect equality        |
| **p90 / p10 Earnings Ratio** | **1.35x**           | Top vs bottom decile spread |
