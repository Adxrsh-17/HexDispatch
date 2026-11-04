# ADR 0007: Dynamic Pricing, Surge Control Loop, and Locked Quotes

- Status: Accepted
- Date: 2026-11-04

## Context

Ride-hailing marketplaces experience severe spatial and temporal demand-supply imbalances during rush hours, severe weather, and transit disruptions. Without price signals:

1. Excess rider demand overwhelms limited driver supply, causing low match rates and lengthy wait times.
2. Drivers have no economic incentive to reposition into underserved high-demand hotspots.
3. Raw instantaneous ratio calculations ($D / S$) create price "flapping" (wild swings every interval), frustrating riders and drivers.
4. If riders see a fare estimate change while completing the booking flow, trust is broken.

We require a principled dynamic pricing engine that computes predictable, non-oscillating surge multipliers per spatial cell and issues deterministic, time-locked fare quotes.

## Alternatives Considered

1. **Unbounded Raw Demand/Supply Ratio:**
   - Multiplier $m = 1 + k \cdot (D/S - 1)$ computed directly every cycle.
   - _Rejected:_ Extreme volatility; momentary traffic spikes cause huge price jumps, and a single new driver arrival drops prices precipitously.
2. **Standard Machine Learning / Black-box Forecasting:**
   - Deep learning or XGBoost estimating willingness-to-pay.
   - _Rejected:_ Violates transparency and regulatory audit requirements. Cannot explain to drivers or riders why a specific surge multiplier was applied.
3. **Closed-Loop Control with EWMA, Step Limiting, Hysteresis, and Neighbour Blending:**
   - Pure function control loop that applies exponential smoothing, rate limits step deltas, enforces a dead-band threshold before changing, and blends adjacent H3 cells.
   - _Accepted:_ Mathematically provable convergence, transparent reproduceable formulas, and smooth spatial transitions.

## Decision

1. **Pure Function Control Loop (`apps/pricing/src/surge-engine.ts`):**
   - **EWMA Smoothing:** $\alpha = 0.3$ on both demand and supply sliding windows (5 minutes).
   - **Ratio Clamping:** $m_{\text{raw}} = 1 + k \cdot \max(0, \frac{\text{demand}_s}{\max(\text{supply}_s, \epsilon)} - 1)$, clamped to $[1.0, 2.5]$.
   - **Step Limiting:** $|m_t - m_{t-1}| \le 0.20$ to prevent abrupt jumps.
   - **Hysteresis Dead-band:** Multiplier increases only if $m_{\text{step}} > m_{t-1} + 0.05$; decreases only if $m_{\text{step}} < m_{t-1} - 0.03$. Eliminates chatter around boundary states.
   - **Neighbour Ring-1 Blending:** Multiplier blends with mean of 6 adjacent H3 res 8 cells: $m_{\text{final}} = (1 - \beta) \cdot m_{\text{cell}} + \beta \cdot m_{\text{neighbours}}$ ($\beta = 0.20$).

2. **Quote Lifecycle & Fare Locking:**
   - `POST /quotes`: Generates a quote calculated with base fare + per-km + per-minute + current cell surge multiplier, rounded in integer minor units (paise/cents).
   - Stores quote in Postgres `quotes` table with TTL (`expires_at = now + 300s`).
   - When a ride is created, `core-api` associates `quote_id`. `POST /quotes/:id/lock` validates that the quote has not expired and binds `ride_id`.
   - The final captured trip fare is strictly equal to the locked quote (or proportionally scaled if destination changes mid-trip).

3. **Spatial Resolution:**
   - H3 Resolution 8 (~0.7 km² area, ~450m edge) is used for surge pricing cells, matching neighborhood-level granularity while avoiding hyper-local fragmentation.

4. **Auditability & Explainability:**
   - `GET /surge/:cell/explain` reproduces every intermediate variable ($\text{demand}_s, \text{supply}_s, \text{ratio}, \text{raw}, \text{stepped}, \text{hysteresis}, \text{neighbours}, \text{final}$).
   - `PUT /admin/surge/:cell` supports manual overrides with required actor, reason, and TTL, logged to `surge_overrides` audit table.
   - Every multiplier change appends an immutable record to `surge_history` and publishes `pricing.surge.updated`.

## Consequences

- **Stability:** Stability unit tests confirm 0 oscillations under steady demand over 120 cycles (1 hour).
- **Rider Fairness:** Guaranteed fixed price for 5 minutes during booking flow.
- **Explainable Pricing:** Support teams and auditors can inspect exact mathematical inputs for any historical surge event.
