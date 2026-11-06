import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, asc } from 'drizzle-orm';
import {
  setupE2EEnvironment,
  runE2ERide,
  type E2ETestEnvironment,
} from '../../../tools/scripts/e2e-ride';
import { rides, rideEvents } from '../../core-api/src/db/schema';

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

  it('completes full ride through Gateway: request -> offer -> accept -> arrived -> in_progress -> completed', async () => {
    const rideId = await runE2ERide(env.gatewayUrl);

    // WebSocket events alone are not proof: core-api owns trip state, so assert it directly.
    const [ride] = await env.coreDb.select().from(rides).where(eq(rides.id, rideId));
    expect(ride?.status).toBe('COMPLETED');
    expect(ride?.driverId).toBeTruthy();

    const history = await env.coreDb
      .select()
      .from(rideEvents)
      .where(eq(rideEvents.rideId, rideId))
      .orderBy(asc(rideEvents.version));
    expect(history.map((e) => e.toState)).toEqual([
      'REQUESTED',
      'MATCHING',
      'OFFERED',
      'ASSIGNED',
      'DRIVER_ARRIVED',
      'IN_PROGRESS',
      'COMPLETED',
    ]);
  });
});
