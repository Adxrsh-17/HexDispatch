import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { runMigrations } from '../src/db/migrate';
import { getCoreDb } from '../src/db/index';
import { buildCoreApiApp } from '../src/app';
import { withInternalAuth } from '@hexdispatch/shared';
import { users, rides } from '../src/db/schema';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';

// Check if Docker runtime is available
async function isDockerAvailable(): Promise<boolean> {
  try {
    const { execSync } = await import('node:child_process');
    execSync('docker info', { stdio: 'ignore', timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

const dockerAvailable = await isDockerAvailable();

describe.skipIf(!dockerAvailable)('Core API Testcontainers Integration (PostgreSQL 16)', () => {
  let container: StartedPostgreSqlContainer;
  let dbConnection: ReturnType<typeof getCoreDb>;
  let app: FastifyInstance;

  beforeAll(async () => {
    // Start real PostgreSQL 16 container
    container = await new PostgreSqlContainer('postgres:16')
      .withDatabase('core')
      .withUsername('hex')
      .withPassword('hex_dev_only')
      .start();

    const connectionUri = container.getConnectionUri();

    // Run migrations on the real container
    await runMigrations(connectionUri);

    dbConnection = getCoreDb(connectionUri);
    app = withInternalAuth(await buildCoreApiApp({ db: dbConnection.db, logLevel: 'silent' }));
    await app.ready();
  }, 60000);

  afterAll(async () => {
    if (app) await app.close();
    if (dbConnection) await dbConnection.close();
    if (container) await container.stop();
  });

  it('runs full authentication, ride lifecycle and transactional state machine on real Postgres container', async () => {
    // 1. User signup
    const signupRes = await app.inject({
      method: 'POST',
      url: '/auth/signup',
      payload: {
        email: 'testcontainers-rider@example.com',
        password: 'Password123!',
        role: 'RIDER',
      },
    });

    expect(signupRes.statusCode).toBe(201);
    const signupBody = signupRes.json();
    const userId = signupBody.user.id;
    expect(userId).toBeDefined();

    // Verify row in real database
    const userRows = await dbConnection.db.select().from(users).where(eq(users.id, userId));
    expect(userRows.length).toBe(1);

    // 2. Create ride with Idempotency-Key
    const idempotencyKey = 'container-key-001';
    const ridePayload = {
      pickup: { lat: 12.9716, lng: 77.5946 },
      dropoff: { lat: 12.9352, lng: 77.6245 },
      vehicleType: 'sedan',
    };

    const rideRes = await app.inject({
      method: 'POST',
      url: '/rides',
      headers: {
        'idempotency-key': idempotencyKey,
        'x-user-id': userId,
        'x-user-role': 'RIDER',
      },
      payload: ridePayload,
    });

    expect(rideRes.statusCode).toBe(201);
    const ride = rideRes.json();
    const rideId = ride.id;
    expect(ride.status).toBe('REQUESTED');

    // 3. Repeating request returns identical ride (idempotent)
    const repeatRes = await app.inject({
      method: 'POST',
      url: '/rides',
      headers: {
        'idempotency-key': idempotencyKey,
        'x-user-id': userId,
        'x-user-role': 'RIDER',
      },
      payload: ridePayload,
    });
    expect(repeatRes.statusCode).toBe(201);
    expect(repeatRes.json().id).toBe(rideId);

    // Verify in real postgres: exactly one ride row
    const rideRows = await dbConnection.db.select().from(rides).where(eq(rides.id, rideId));
    expect(rideRows.length).toBe(1);

    // 4. Transition ride state: REQUESTED -> MATCHING (SYSTEM)
    const transitionRes = await app.inject({
      method: 'POST',
      url: `/rides/${rideId}/transition`,
      headers: {
        'x-user-role': 'SYSTEM',
      },
      payload: {
        to: 'MATCHING',
        expectedVersion: 0,
      },
    });

    expect(transitionRes.statusCode).toBe(200);
    const updatedRide = transitionRes.json();
    expect(updatedRide.status).toBe('MATCHING');
    expect(updatedRide.version).toBe(1);

    // 5. Query ride via GET /rides/:id
    const getRes = await app.inject({
      method: 'GET',
      url: `/rides/${rideId}`,
    });
    expect(getRes.statusCode).toBe(200);
    expect(getRes.json().status).toBe('MATCHING');
  });
});
