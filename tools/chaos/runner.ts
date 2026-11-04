import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runKillRedisChaos } from './kill-redis';
import { runKillKafkaChaos } from './kill-kafka';
import { runKillDispatchChaos } from './kill-dispatch';
import { runKillGatewayChaos } from './kill-gateway';
import type { ChaosResult } from './common';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export async function runAllChaosScenarios(): Promise<ChaosResult[]> {
  console.log('====================================================');
  console.log('HexDispatch Chaos Engineering Test Suite (Phase 8 AC2)');
  console.log('====================================================\n');

  const results: ChaosResult[] = [];

  // 1. Kill Redis
  results.push(await runKillRedisChaos());
  console.log('----------------------------------------------------');

  // 2. Kill Kafka
  results.push(await runKillKafkaChaos());
  console.log('----------------------------------------------------');

  // 3. Kill Dispatch
  results.push(await runKillDispatchChaos());
  console.log('----------------------------------------------------');

  // 4. Kill Gateway
  results.push(await runKillGatewayChaos());
  console.log('----------------------------------------------------');

  return results;
}

export function generateResilienceMarkdown(results: ChaosResult[]): string {
  const timestamp = new Date().toISOString();
  return `# HexDispatch System Resilience & Failure Injection Report

## Overview
This document records failure injection and chaos engineering outcomes across all critical infrastructure and microservices in HexDispatch, as required by Phase 8 Acceptance Criterion 2.

**Audit Date:** ${timestamp}  
**Architecture Guardrails:** Outbox Pattern, Double-Entry Ledger, Idempotency Keys, Circuit Breakers, Bounded Queues.

---

## Failure Scenarios Summary

| Target Subsystem | Failure Injected | Degraded Behaviour | Data Loss? | Measured Recovery Time |
| :--- | :--- | :--- | :--- | :--- |
${results
  .map(
    (r) =>
      `| **${r.target}** | \`${r.scenario}\` | ${r.expectedDegraded.slice(0, 75)}... | **${r.dataLoss ? 'YES' : 'NO'}** | **${r.recoveryTimeMs}ms** |`,
  )
  .join('\n')}

---

## Detailed Scenario Findings

${results
  .map(
    (r, idx) => `### ${idx + 1}. Scenario: \`${r.scenario}\` (${r.target})
- **Expected Degraded Behaviour:**  
  ${r.expectedDegraded}
- **Observed Behaviour During Outage:**  
  ${r.observedDegraded}
- **Data Loss:** **${r.dataLoss ? 'YES' : 'NO'}**  
  *Details:* ${r.dataLossDetails}
- **Measured Recovery Time:** **${r.recoveryTimeMs}ms**
`,
  )
  .join('\n')}

---

## Resilience Architecture Principles

1. **Transactional Outbox for Asynchronous Messaging:**
   - Every domain event in \`core-api\` is written into PostgreSQL in the same database transaction as the business entity update.
   - When Kafka/Redpanda is partitioned or offline, business operations continue without data loss; events accumulate in the outbox table and are drained causally once the broker recovers.

2. **Decoupled Durability (PostgreSQL) vs Ephemeral State (Redis):**
   - Core financial records, trip states, and audit trails reside in PostgreSQL.
   - Redis holds spatial indexes and atomic driver lock claims with TTLs. If Redis crashes, claims safely expire, preventing permanent deadlocks. Spatial indexes repopulate rapidly as active drivers stream GPS pings.

3. **Circuit Breakers on Synchronous Cross-Service HTTP:**
   - Gateway and dispatch enforce circuit breakers (\`CLOSED\` -> \`OPEN\` -> \`HALF_OPEN\`) with strict timeouts (3000ms) and fallbacks.
   - Microservice downtime fails fast (503 Service Unavailable) rather than cascading thread exhaustion or hanging socket buffers.

4. **Saga Resumption & PSP Idempotency:**
   - Payment sagas survive mid-step service crashes and process restarts via \`resumePendingSagas()\`.
   - Deterministic idempotency keys (\`auth:\${rideId}\`, \`capture:\${rideId}\`) prevent duplicate financial charges across retries and network timeouts.
`;
}

export async function main(): Promise<void> {
  const results = await runAllChaosScenarios();
  const md = generateResilienceMarkdown(results);
  const outPath = path.resolve(__dirname, '../../docs/resilience.md');
  fs.writeFileSync(outPath, md, 'utf-8');
  console.log(`\nResilience documentation generated at: ${outPath}`);
}

if (process.argv[1]?.includes('runner')) {
  main().catch((err) => {
    console.error('Chaos suite error:', err);
    process.exit(1);
  });
}
