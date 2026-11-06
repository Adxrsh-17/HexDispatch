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
  const cell = (r: ChaosResult) =>
    r.status === 'MEASURED' ? `${r.containerRecoveryMs} ms` : `NOT RUN (${r.reason})`;

  return `# HexDispatch Failure Injection Report

**Generated:** ${timestamp}
**Command:** \`pnpm chaos\`

## What this report is, and is not

- **Measured** means one thing: the time from \`docker stop\` of a dependency container until its health probe passes again after \`docker start\`. That is infrastructure recovery time.
- **Not measured:** how HexDispatch services behave during the outage, and whether any data is lost. The "Expected behaviour" column is design intent taken from the code, not an observation. Backing it with assertions against running services is open work.
- A scenario that cannot run says **NOT RUN** and gives the reason. This runner never fabricates a number. (An earlier version did: it slept for a fixed time when Docker was absent and reported that as a recovery time. Those figures were removed.)

## Results

| Scenario | Target | Container recovery | Expected behaviour (design intent, not observed) |
| :--- | :--- | :--- | :--- |
${results.map((r) => `| \`${r.scenario}\` | ${r.target} | ${cell(r)} | ${r.expectedBehaviour} |`).join('\n')}

## Where restart and failure behaviour is actually tested

These are automated tests in the repository, run with \`pnpm test\` (in-process, on PGlite and an in-memory Redis, not on real containers):

- Offer accept/decline/expire races, core-api refusal handling, claim atomicity: \`apps/dispatch/test/hardening.test.ts\`
- Dispatch restart with a pending offer: \`apps/dispatch/test/recovery.test.ts\`
- Dispatch restart with pending (not yet offered) rides, solver failure and slow-solve fallback: \`apps/dispatch/test/hardening.test.ts\`
- Payment saga resume after a crash mid-step: \`apps/payment/test/saga-recovery.test.ts\`
- Outbox relay: \`apps/core-api/test/outbox-relay.test.ts\`

## Not yet tested against real infrastructure

Real Postgres, Redis and Kafka failure behaviour. The \`*.testcontainers.test.ts\` suites exist but need Docker.
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
