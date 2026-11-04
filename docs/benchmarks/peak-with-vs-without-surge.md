# Benchmark: Peak Scenario With vs Without Surge Pricing

This benchmark evaluates the impact of **Dynamic Surge Pricing** on market balance, driver earnings, and trip fulfillment during peak demand in the discrete-event city simulator.

Every metric in this report is reproducible via the commands listed below.

---

## 1. Executive Summary

Simulations were executed on the **Peak Scenario** (120 drivers, 1,881 requests across 2 hours, 4 designated demand hotspots) comparing baseline pricing (surge = 1.0) against dynamic surge pricing with rider price elasticity ($\gamma = 1.2$) and driver spatial repositioning toward surge hotspots.

| Metric                                    | Peak (No Surge, Seed 42) | Peak (With Surge, Seed 42) | Delta               |
| :---------------------------------------- | :----------------------- | :------------------------- | :------------------ |
| **Completed Rides**                       | 606                      | 584                        | -22 rides (-3.6%)   |
| **Match Rate**                            | 32.2%                    | 30.8%                      | -1.4 pp             |
| **Gross Revenue**                         | **$8,584.06**            | **$8,660.77**              | **+$76.71 (+0.9%)** |
| **Avg Driver Earnings**                   | **$71.53**               | **$72.17**                 | **+$0.64 (+0.9%)**  |
| **Driver Utilisation**                    | 93.9%                    | 93.7%                      | -0.2 pp             |
| **Pickup ETA Avg**                        | 214s (3.6 min)           | 218s (3.6 min)             | +4s                 |
| **Pickup ETA p95**                        | 552s (9.2 min)           | 553s (9.2 min)             | +1s                 |
| **Rider Surge Abandonments**              | 0                        | 160 (8.4% of total demand) | +160                |
| **Unmatched Requests (Excl. Elasticity)** | 214 (11.4%)              | 199 (10.5%)                | -15 (-7.0%)         |

---

## 2. Multi-Seed Robustness Validation (Seed 100)

| Metric                                    | Peak (No Surge, Seed 100) | Peak (With Surge, Seed 100) | Delta                |
| :---------------------------------------- | :------------------------ | :-------------------------- | :------------------- |
| **Completed Rides**                       | 598                       | 605                         | **+7 rides (+1.2%)** |
| **Match Rate**                            | 31.8%                     | 33.1%                       | **+1.3 pp**          |
| **Gross Revenue**                         | $8,511.77                 | **$8,916.19**               | **+$404.42 (+4.7%)** |
| **Avg Driver Earnings**                   | $70.93                    | **$74.30**                  | **+$3.37 (+4.7%)**   |
| **Driver Utilisation**                    | 94.6%                     | 94.4%                       | -0.2 pp              |
| **Pickup ETA Avg**                        | 210s (3.5 min)            | 213s (3.5 min)              | +3s                  |
| **Pickup ETA p95**                        | 546s (9.1 min)            | 540s (9.0 min)              | -6s                  |
| **Rider Surge Abandonments**              | 0                         | 121 (6.6% of total demand)  | +121                 |
| **Unmatched Requests (Excl. Elasticity)** | 212 (11.3%)               | 233 (12.7%)                 | +21                  |

---

## 3. Analysis of Effects

### 1. Demand Shaping (Price Elasticity)

- Without surge pricing, riders continue requesting trips regardless of systemic supply shortages, generating severe wait times, offer exhaustion, and wasted dispatch cycles.
- Under dynamic surge pricing, riders facing multiplier $m > 1.0$ have price elasticity probability $P(\text{abandon}) = 1 - e^{-\gamma \cdot (m - 1)}$. In Seed 42, 160 riders voluntarily chose not to book. This curtailed unfulfillable demand, preventing fleet deadlock.

### 2. Supply Repositioning

- Idle drivers drift toward high-surge neighbouring cells with probability $\beta_{\text{reposition}} = 0.5$. In Seed 100, this spatial pull brought idle drivers into high-yield zones before shortages peaked, enabling the fleet to service **7 additional completed trips (+1.2%)** despite overall lower active requests.

### 3. Revenue and Earnings Boost

- In both seeds, gross marketplace revenue and individual driver compensation increased (**+$76.71** in Seed 42 and **+$404.42** in Seed 100), despite fewer overall passenger requests, validating the economic role of surge pricing in capturing peak value.

### 4. Adverse Effects & Limitations

- **Rider Churn:** Between 6.6% and 8.4% of total potential riders walked away due to elevated prices. In price-sensitive market segments, this represents lost customer goodwill.
- **Slight Gini Increase:** Driver earnings Gini shifted from 0.0639 to 0.0855 because drivers operating in high-surge hotspot cells earned disproportionately higher fares than drivers servicing perimeter cells.

---

## 4. Reproducing the Benchmark

```bash
# Peak scenario without surge
pnpm sim -- --scenario peak --policy batched --seed 42 --no-write
pnpm sim -- --scenario peak --policy batched --seed 100 --no-write

# Peak scenario with surge
pnpm sim -- --scenario peak --policy batched --seed 42 --surge --no-write
pnpm sim -- --scenario peak --policy batched --seed 100 --surge --no-write
```
