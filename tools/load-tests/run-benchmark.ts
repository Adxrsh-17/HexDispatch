import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import Redis from 'ioredis-mock';
import { DriverIndex } from '../../apps/location/src/driver-index';
import { NearbySearch } from '../../apps/location/src/nearby';
import { LocationBatchPublisher } from '../../apps/location/src/batch-publisher';
import { buildLocationApp } from '../../apps/location/src/app';

async function main() {
  console.log('--- Starting Location Benchmark Setup ---');

  const redis = new Redis();
  const driverIndex = new DriverIndex(redis as any);
  const nearbySearch = new NearbySearch(driverIndex);

  let totalPublished = 0;
  const mockProducer = {
    publishBatch: async (messages: any[]) => {
      totalPublished += messages.length;
    },
  };

  const batchPublisher = new LocationBatchPublisher(mockProducer as any, {
    batchSize: 50,
    flushIntervalMs: 200,
  });

  const app = await buildLocationApp({
    driverIndex,
    nearbySearch,
    batchPublisher,
    logLevel: 'warn',
  });

  const address = await app.listen({ host: '127.0.0.1', port: 3002 });
  console.log(`Location service listening on ${address}`);

  const k6Bin = path.resolve(process.cwd(), 'tools/bin/k6.exe');
  const scriptPath = path.resolve(process.cwd(), 'tools/load-tests/location-pings.js');

  if (!fs.existsSync(k6Bin)) {
    console.error(`k6 binary not found at ${k6Bin}`);
    await app.close();
    process.exit(1);
  }

  console.log(`Executing k6 benchmark: ${k6Bin} run ${scriptPath}`);
  const k6Process = spawn(k6Bin, ['run', scriptPath], {
    env: { ...process.env, BASE_URL: 'http://127.0.0.1:3002' },
    stdio: 'inherit',
  });

  k6Process.on('exit', async (code) => {
    console.log(`\nk6 process completed with exit code ${code}`);
    console.log(`Total location pings batched and published: ${totalPublished}`);
    batchPublisher.stop();
    await app.close();
    process.exit(code ?? 0);
  });
}

main().catch((err) => {
  console.error('Benchmark runner error:', err);
  process.exit(1);
});
