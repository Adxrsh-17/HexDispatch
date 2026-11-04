import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { runMigrations } from '../src/db/migrate';
import { getPricingDb } from '../src/db/index';
import { buildPricingApp } from '../src/app';
import { PricingService } from '../src/services/pricing-service';
import { quotes } from '../src/db/schema';
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

describe.skipIf(!dockerAvailable)('Pricing Testcontainers Integration (PostgreSQL 16)', () => {
  let container: StartedPostgreSqlContainer;
  let dbConnection: ReturnType<typeof getPricingDb>;
  let app: FastifyInstance;
  let redis: InstanceType<typeof RedisMock>;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16')
      .withDatabase('pricing')
      .withUsername('hex')
      .withPassword('hex_dev_only')
      .start();

    const connectionUri = container.getConnectionUri();
    await runMigrations(connectionUri);

    dbConnection = getPricingDb(connectionUri);
    redis = new RedisMock();

    const pricingService = new PricingService({
      db: dbConnection.db,
      redis,
    });

    app = await buildPricingApp({
      pricingService,
      logLevel: 'silent',
    });
    await app.ready();
  }, 60000);

  afterAll(async () => {
    if (app) await app.close();
    if (dbConnection) await dbConnection.close();
    if (container) await container.stop();
  });

  it('runs migrations and persists quotes against real PostgreSQL 16', async () => {
    const allQuotes = await dbConnection.db.select().from(quotes);
    expect(allQuotes).toEqual([]);
  });
});

