# Benchmark: PEAK Scenario (greedy)

- **Scenario:** `peak`
- **Policy:** `greedy`
- **Seed:** `42`
- **Git Commit:** `dad2ff2`
- **Executed Command:** `pnpm sim --scenario peak --policy greedy --seed 42 --anomalies`
- **Simulation Duration:** 2 hours (7200s)
- **Timestamp:** 2026-11-04T12:20:01.728Z

## Key Metrics

| Metric                       | Value               | Target / Note               |
| ---------------------------- | ------------------- | --------------------------- |
| **Total Ride Requests**      | **1894**            | Total passenger ride demand |
| **Completed Rides**          | **542**             | Completed and paid trips    |
| **Match Rate**               | **28.6%**           | Fulfilled demand percentage |
| **No-Driver Rate**           | **65.1%**           | Unserviced requests         |
| **Pickup ETA (Average)**     | **314s** (~5.2 min) | Average wait until arrival  |
| **Pickup ETA (p95)**         | **566s** (~9.4 min) | 95th percentile worst wait  |
| **Pickup ETA (Median)**      | **312s**            | 50th percentile             |
| **Driver Utilisation**       | **92.8%**           | Time on-trip or dispatched  |
| **Avg Idle Time**            | **488s**            | Non-earning roaming time    |
| **Productivity**             | **2.26** rides/hr   | Rides per driver shift hour |
| **Total Revenue**            | **$7649.53**        | Total gross bookings        |
| **Avg Driver Earnings**      | **$63.75**          | Mean earnings per shift     |
| **Earnings Gini**            | **0.058**           | 0 = perfect equality        |
| **p90 / p10 Earnings Ratio** | **1.32x**           | Top vs bottom decile spread |
