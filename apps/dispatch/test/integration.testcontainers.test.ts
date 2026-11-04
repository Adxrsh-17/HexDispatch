import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { runMigrations } from '../src/db/migrate';
import { getDispatchDb } from '../src/db/index';
import { buildDispatchApp } from '../src/app';
import { DriverClaimService } from '../src/services/driver-claim';
import { MatchingRegistry } from '../src/services/matching-registry';
import { OfferManager } from '../src/services/offer-manager';
import { DispatchEngine } from '../src/services/dispatch-engine';
import { offers } from '../src/db/schema';
import RedisMock from 'ioredis-mock';
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

describe.skipIf(!dockerAvailable)('Dispatch Testcontainers Integration (PostgreSQL 16)', () => {
  let container: StartedPostgreSqlContainer;
  let dbConnection: ReturnType<typeof getDispatchDb>;
  let app: FastifyInstance;
  let redis: InstanceType<typeof RedisMock>;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16')
      .withDatabase('dispatch')
      .withUsername('hex')
      .withPassword('hex_dev_only')
      .start();

    const connectionUri = container.getConnectionUri();
    await runMigrations(connectionUri);

    dbConnection = getDispatchDb(connectionUri);
    redis = new RedisMock();

    const claimService = new DriverClaimService(redis);
    const matchingRegistry = new MatchingRegistry();
    const offerManager = new OfferManager({
      db: dbConnection.db,
      redis,
      claimService,
    });

    const dispatchEngine = new DispatchEngine({
      db: dbConnection.db,
      offerManager,
      matchingRegistry,
      claimService,
    });

    app = await buildDispatchApp({
      offerManager,
      dispatchEngine,
      logLevel: 'silent',
    });
    await app.ready();
  }, 60000);

  afterAll(async () => {
    if (app) await app.close();
    if (dbConnection) await dbConnection.close();
    if (container) await container.stop();
  });

  it('runs migrations and accepts offers against real PostgreSQL 16', async () => {
    const allOffers = await dbConnection.db.select().from(offers);
    expect(allOffers).toEqual([]);
  });
});
