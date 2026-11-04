import { describe, it, beforeAll, afterAll } from 'vitest';
import {
  setupE2EEnvironment,
  runE2ERide,
  type E2ETestEnvironment,
} from '../../../tools/scripts/e2e-ride';

describe('End-to-End Ride Lifecycle via Gateway (AC1)', () => {
  let env: E2ETestEnvironment;

  beforeAll(async () => {
    env = await setupE2EEnvironment();
  });

  afterAll(async () => {
    if (env) {
      await env.close();
    }
  });

  it('completes full ride through Gateway: request -> offer -> accept -> arrived -> in_trip -> completed', async () => {
    await runE2ERide(env.gatewayUrl);
  });
});
