import type { SimMetrics, CompletedRideRecord } from './collector';
import type { SimDriver } from '../models/driver';

export interface ReportMetadata {
  scenario: string;
  policy: string;
  seed: number;
  commit: string;
  command: string;
  durationSec: number;
  timestamp: string;
}

export function generateCsvReport(
  metadata: ReportMetadata,
  metrics: SimMetrics,
  drivers: readonly SimDriver[],
): string {
  const lines: string[] = [];

  // Metadata block
  lines.push('# HexDispatch Simulation Benchmark Report');
  lines.push(`# Scenario: ${metadata.scenario}`);
  lines.push(`# Policy: ${metadata.policy}`);
  lines.push(`# Seed: ${metadata.seed}`);
  lines.push(`# Commit: ${metadata.commit}`);
  lines.push(`# Command: ${metadata.command}`);
  lines.push(`# Duration: ${metadata.durationSec}s`);
  lines.push(`# GeneratedAt: ${metadata.timestamp}`);
  lines.push('');

  // Summary Metrics Header & Values
  const summaryHeaders = [
    'scenario',
    'policy',
    'seed',
    'totalRequests',
    'completedRides',
    'unmatchedRides',
    'matchRate',
    'noDriverRate',
    'pickupEtaAvgSec',
    'pickupEtaP95Sec',
    'pickupEtaMedianSec',
    'driverUtilisation',
    'idleTimeAvgSec',
    'ridesPerDriverHour',
    'giniCoefficient',
    'p90p10Ratio',
    'totalRevenueUSD',
  ];

  const summaryValues = [
    metadata.scenario,
    metadata.policy,
    metadata.seed,
    metrics.totalRequests,
    metrics.completedRides,
    metrics.unmatchedRides,
    metrics.matchRate,
    metrics.noDriverRate,
    metrics.pickupEtaAvgSec,
    metrics.pickupEtaP95Sec,
    metrics.pickupEtaMedianSec,
    metrics.driverUtilisation,
    metrics.idleTimeAvgSec,
    metrics.ridesPerDriverHour,
    metrics.giniCoefficient,
    metrics.p90p10EarningsRatio,
    (metrics.totalFareRevenueCents / 100).toFixed(2),
  ];

  lines.push(summaryHeaders.join(','));
  lines.push(summaryValues.join(','));
  lines.push('');

  // Per-driver detail table
  lines.push('# Driver Level Statistics');
  lines.push(
    'driverId,status,completedTrips,acceptedOffers,declinedOffers,timedOutOffers,earningsUSD,idleTimeSec,dispatchedTimeSec,tripTimeSec,totalDistanceKm,utilisation',
  );

  for (const d of drivers) {
    const shiftSec = Math.max(1, d.shiftEndSec - d.shiftStartSec);
    const util = (d.totalTripTimeSec + d.totalDispatchedTimeSec) / shiftSec;
    lines.push(
      [
        d.id,
        d.status,
        d.completedTrips,
        d.acceptedOffers,
        d.declinedOffers,
        d.timedOutOffers,
        (d.totalEarningsCents / 100).toFixed(2),
        Math.round(d.totalIdleTimeSec),
        Math.round(d.totalDispatchedTimeSec),
        Math.round(d.totalTripTimeSec),
        (d.totalDistanceMeters / 1000).toFixed(2),
        util.toFixed(4),
      ].join(','),
    );
  }

  return lines.join('\n');
}

/**
 * Generates an SVG histogram chart of pickup ETAs.
 */
export function generateEtaDistributionSvg(rides: readonly CompletedRideRecord[]): string {
  const buckets = [
    { label: '<2m', maxSec: 120, count: 0 },
    { label: '2-4m', maxSec: 240, count: 0 },
    { label: '4-6m', maxSec: 360, count: 0 },
    { label: '6-8m', maxSec: 480, count: 0 },
    { label: '8-10m', maxSec: 600, count: 0 },
    { label: '>10m', maxSec: Infinity, count: 0 },
  ];

  for (const r of rides) {
    const eta = r.pickupEtaSec;
    if (eta < 120) buckets[0]!.count++;
    else if (eta < 240) buckets[1]!.count++;
    else if (eta < 360) buckets[2]!.count++;
    else if (eta < 480) buckets[3]!.count++;
    else if (eta < 600) buckets[4]!.count++;
    else buckets[5]!.count++;
  }

  const maxCount = Math.max(1, ...buckets.map((b) => b.count));
  const svgWidth = 600;
  const svgHeight = 320;
  const chartHeight = 220;
  const barWidth = 60;
  const gap = 30;
  const startX = 60;

  const bars = buckets
    .map((b, i) => {
      const height = Math.round((b.count / maxCount) * chartHeight);
      const x = startX + i * (barWidth + gap);
      const y = 250 - height;
      return `
        <rect x="${x}" y="${y}" width="${barWidth}" height="${height}" fill="#2563eb" rx="4" />
        <text x="${x + barWidth / 2}" y="${y - 8}" text-anchor="middle" font-size="12" fill="#1e293b" font-weight="bold">${b.count}</text>
        <text x="${x + barWidth / 2}" y="270" text-anchor="middle" font-size="12" fill="#64748b">${b.label}</text>
      `;
    })
    .join('');

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${svgWidth} ${svgHeight}" width="${svgWidth}" height="${svgHeight}">
  <rect width="100%" height="100%" fill="#ffffff" />
  <text x="300" y="30" text-anchor="middle" font-size="16" font-weight="bold" fill="#0f172a">Pickup ETA Distribution (Seconds)</text>
  <line x1="40" y1="250" x2="560" y2="250" stroke="#cbd5e1" stroke-width="2" />
  ${bars}
</svg>`;
}

export function generateMarkdownSummary(metadata: ReportMetadata, metrics: SimMetrics): string {
  return `# Benchmark: ${metadata.scenario.toUpperCase()} Scenario (${metadata.policy})

- **Scenario:** \`${metadata.scenario}\`
- **Policy:** \`${metadata.policy}\`
- **Seed:** \`${metadata.seed}\`
- **Git Commit:** \`${metadata.commit}\`
- **Executed Command:** \`${metadata.command}\`
- **Simulation Duration:** ${metadata.durationSec / 3600} hours (${metadata.durationSec}s)
- **Timestamp:** ${metadata.timestamp}

## Key Metrics

| Metric | Value | Target / Note |
|---|---|---|
| **Total Ride Requests** | **${metrics.totalRequests}** | Total passenger ride demand |
| **Completed Rides** | **${metrics.completedRides}** | Completed and paid trips |
| **Match Rate** | **${(metrics.matchRate * 100).toFixed(1)}%** | Fulfilled demand percentage |
| **No-Driver Rate** | **${(metrics.noDriverRate * 100).toFixed(1)}%** | Unserviced requests |
| **Pickup ETA (Average)** | **${Math.round(metrics.pickupEtaAvgSec)}s** (~${(metrics.pickupEtaAvgSec / 60).toFixed(1)} min) | Average wait until arrival |
| **Pickup ETA (p95)** | **${Math.round(metrics.pickupEtaP95Sec)}s** (~${(metrics.pickupEtaP95Sec / 60).toFixed(1)} min) | 95th percentile worst wait |
| **Pickup ETA (Median)** | **${Math.round(metrics.pickupEtaMedianSec)}s** | 50th percentile |
| **Driver Utilisation** | **${(metrics.driverUtilisation * 100).toFixed(1)}%** | Time on-trip or dispatched |
| **Avg Idle Time** | **${Math.round(metrics.idleTimeAvgSec)}s** | Non-earning roaming time |
| **Productivity** | **${metrics.ridesPerDriverHour}** rides/hr | Rides per driver shift hour |
| **Total Revenue** | **$${(metrics.totalFareRevenueCents / 100).toFixed(2)}** | Total gross bookings |
| **Avg Driver Earnings** | **$${(metrics.avgDriverEarningsCents / 100).toFixed(2)}** | Mean earnings per shift |
| **Earnings Gini** | **${metrics.giniCoefficient}** | 0 = perfect equality |
| **p90 / p10 Earnings Ratio** | **${metrics.p90p10EarningsRatio}x** | Top vs bottom decile spread |
`;
}
