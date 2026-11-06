/**
 * Runs the k6 scripts against in-process services and writes docs/benchmarks/load-test-benchmarks.md.
 *
 * Every number in the report is parsed from the k6 `--summary-export` JSON. If a metric is missing
 * the run fails; there are no fallback values. (An earlier version fell back to hard-coded
 * constants when it parsed the wrong JSON shape, and those constants were published as results.)
 *
 * Requires the `k6` binary on PATH (or K6_BIN). It targets in-process servers backed by PGlite and
 * an in-memory Redis, so it measures code paths, not real infrastructure.
 */
import { spawn, execSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import Redis from 'ioredis-mock';
import { resolveInternalToken, signAccessToken } from '../../packages/shared/src';
import { DriverIndex } from '../../apps/location/src/driver-index';
import { NearbySearch } from '../../apps/location/src/nearby';
import { LocationBatchPublisher } from '../../apps/location/src/batch-publisher';
import { buildLocationApp } from '../../apps/location/src/app';
import { buildCoreApiApp } from '../../apps/core-api/src/app';
import { createTestDb } from '../../apps/core-api/test/test-db';
import { users } from '../../apps/core-api/src/db/schema';
import { buildGatewayApp } from '../../apps/gateway/src/app';
import { RealtimeGateway } from '../../apps/gateway/src/ws/gateway-ws';

const k6Bin = process.env.K6_BIN ?? 'k6';
const root = process.cwd();

function sh(cmd: string, fallback: string): string {
  try {
    return execSync(cmd, { encoding: 'utf-8' }).trim();
  } catch {
    return fallback;
  }
}

type FlatMetrics = Record<string, Record<string, number>>;

function runK6(script: string, summaryFile: string, env: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      k6Bin,
      [
        'run',
        '--summary-export',
        summaryFile,
        '--summary-trend-stats',
        'avg,min,med,max,p(90),p(95),p(99)',
        script,
      ],
      {
        env: { ...process.env, INTERNAL_TOKEN: resolveInternalToken(), ...env },
        stdio: 'inherit',
      },
    );
    proc.on('error', (err) =>
      reject(
        new Error(`could not start k6 ("${k6Bin}"): ${err.message}. Install k6 or set K6_BIN.`),
      ),
    );
    proc.on('close', (code) => resolve(code ?? 1));
  });
}

function need(metrics: FlatMetrics, metric: string, field: string): number {
  const value = metrics[metric]?.[field];
  if (typeof value !== 'number') {
    throw new Error(`k6 summary is missing ${metric}.${field}; refusing to invent a value`);
  }
  return value;
}

interface Row {
  name: string;
  script: string;
  total: number;
  ratePerSec: number;
  failed: number | null;
  p50: number;
  p95: number;
  p99: number;
  extra: string;
}

function readSummary(file: string): FlatMetrics {
  const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as { metrics: FlatMetrics };
  return parsed.metrics;
}

async function main(): Promise<void> {
  const rows: Row[] = [];
  const outDir = path.resolve(root, 'docs/benchmarks/raw');
  fs.mkdirSync(outDir, { recursive: true });

  // 1. Location ingest ---------------------------------------------------------------
  {
    const redis = new Redis();
    const driverIndex = new DriverIndex(redis as never);
    const batchPublisher = new LocationBatchPublisher({ publishBatch: async () => {} } as never, {
      batchSize: 50,
      flushIntervalMs: 200,
    });
    const app = await buildLocationApp({
      driverIndex,
      nearbySearch: new NearbySearch(driverIndex),
      batchPublisher,
      logLevel: 'silent',
    });
    await app.listen({ host: '127.0.0.1', port: 3002 });
    const file = path.join(outDir, 'location-pings.json');
    const code = await runK6(path.join(root, 'tools/load-tests/location-pings.js'), file, {
      BASE_URL: 'http://127.0.0.1:3002',
    });
    batchPublisher.stop();
    await app.close();
    const m = readSummary(file);
    rows.push({
      name: 'Location ping ingest (POST /drivers/me/location)',
      script: 'location-pings.js',
      total: need(m, 'http_reqs', 'count'),
      ratePerSec: need(m, 'http_reqs', 'rate'),
      failed: need(m, 'http_req_failed', 'passes'),
      p50: need(m, 'http_req_duration', 'med'),
      p95: need(m, 'http_req_duration', 'p(95)'),
      p99: need(m, 'http_req_duration', 'p(99)'),
      extra: `k6 exit code ${code}`,
    });
  }

  // 2. Ride creation -------------------------------------------------------------------
  {
    const db = await createTestDb();
    for (let i = 1; i <= 10; i++) {
      await db.db
        .insert(users)
        .values({
          id: `10000000-0000-0000-0000-${String(i).padStart(12, '0')}`,
          email: `rider-k6-${i}@hexdispatch.internal`,
          passwordHash: 'dummy',
          role: 'RIDER',
        })
        .onConflictDoNothing();
    }
    const app = await buildCoreApiApp({ db: db.db, logLevel: 'silent' });
    await app.listen({ host: '127.0.0.1', port: 3001 });
    const file = path.join(outDir, 'ride-creation.json');
    const code = await runK6(path.join(root, 'tools/load-tests/ride-creation.js'), file, {
      BASE_URL: 'http://127.0.0.1:3001',
    });
    await app.close();
    await db.clean();
    const m = readSummary(file);
    rows.push({
      name: 'Ride creation + outbox row (POST /rides, PGlite)',
      script: 'ride-creation.js',
      total: need(m, 'http_reqs', 'count'),
      ratePerSec: need(m, 'http_reqs', 'rate'),
      failed: need(m, 'http_req_failed', 'passes'),
      p50: need(m, 'http_req_duration', 'med'),
      p95: need(m, 'http_req_duration', 'p(95)'),
      p99: need(m, 'http_req_duration', 'p(99)'),
      extra: `k6 exit code ${code}`,
    });
  }

  // 3. WebSocket connect + ping/pong ---------------------------------------------------
  {
    const pub = new Redis();
    const sub = new Redis();
    const app = await buildGatewayApp({
      realtimeGateway: new RealtimeGateway(pub as never, sub as never),
      logLevel: 'silent',
    });
    await app.listen({ host: '127.0.0.1', port: 3000 });
    const token = await signAccessToken({
      userId: '20000000-0000-0000-0000-000000000001',
      role: 'RIDER',
      email: 'ws-load@hexdispatch.internal',
    });
    const file = path.join(outDir, 'ws-fanout.json');
    const code = await runK6(path.join(root, 'tools/load-tests/ws-fanout.js'), file, {
      WS_URL: 'ws://127.0.0.1:3000/ws',
      WS_TOKEN: token,
    });
    await app.close();
    const m = readSummary(file);
    rows.push({
      name: 'WebSocket connect + authenticated ping/pong (gateway)',
      script: 'ws-fanout.js',
      total: need(m, 'ws_sessions', 'count'),
      ratePerSec: need(m, 'ws_sessions', 'rate'),
      failed: null,
      p50: need(m, 'ws_connect_duration_ms', 'med'),
      p95: need(m, 'ws_connect_duration_ms', 'p(95)'),
      p99: need(m, 'ws_connect_duration_ms', 'p(99)'),
      extra: `pongs received: ${need(m, 'ws_pongs_k6', 'count')}; k6 exit code ${code}`,
    });
  }

  const k6Version = sh(`${k6Bin} version`, 'unknown');
  const machine = `${os.type()} ${os.arch()} | ${os.cpus()[0]?.model ?? 'CPU'} (${os.cpus().length} logical CPUs) | ${(os.totalmem() / 1e9).toFixed(1)} GB RAM`;
  const fmt = (n: number) => (Math.round(n * 100) / 100).toString();

  const report = `# Load test results (smoke-scale, in-process)

> **How to read this.** Each run is a few seconds long with 10 constant virtual users against in-process servers backed by PGlite and an in-memory Redis, on a development laptop. "Throughput" is how fast 10 looping users finished requests, not a capacity limit. Nothing here was measured against real Postgres, Redis or Kafka. Do not quote these as service capacity.
>
> Every number is parsed from the raw k6 summaries in \`docs/benchmarks/raw/\`. The report generator fails if a metric is missing; it has no fallback values.

- **Date:** ${new Date().toISOString()}
- **Git commit:** \`${sh('git rev-parse --short HEAD', 'unknown')}\`
- **Machine:** ${machine}
- **k6:** ${k6Version}
- **Command:** \`pnpm bench:load\`

| Workflow | Script | Requests / sessions | Per second | Failed | p50 (ms) | p95 (ms) | p99 (ms) | Notes |
| :-- | :-- | --: | --: | --: | --: | --: | --: | :-- |
${rows
  .map(
    (r) =>
      `| ${r.name} | \`${r.script}\` | ${r.total} | ${fmt(r.ratePerSec)} | ${r.failed ?? 'n/a'} | ${fmt(r.p50)} | ${fmt(r.p95)} | ${fmt(r.p99)} | ${r.extra} |`,
  )
  .join('\n')}

The WebSocket row measures connection setup (handshake and token verification) and one ping/pong round trip per session. It does not measure room fan-out.
`;
  fs.writeFileSync(path.resolve(root, 'docs/benchmarks/load-test-benchmarks.md'), report, 'utf-8');
  console.log('\nWrote docs/benchmarks/load-test-benchmarks.md');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Load test run failed:', err);
    process.exit(1);
  });
