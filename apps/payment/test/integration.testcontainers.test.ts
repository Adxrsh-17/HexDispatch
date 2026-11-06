import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { runMigrations } from '../src/db/migrate';
import { getPaymentDb } from '../src/db/index';
import { buildPaymentApp } from '../src/app';
import { withInternalAuth } from '@hexdispatch/shared';
import { DoubleEntryLedger, assertLedgerInvariant } from '../src/ledger/double-entry';
import { MockPspClient } from '../src/psp/mock-psp';
import { PaymentSagaService } from '../src/services/payment-saga';
import { ReconciliationService } from '../src/services/reconciliation';
import type { FastifyInstance } from 'fastify';

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

describe.skipIf(!dockerAvailable)('Payment Testcontainers Integration (PostgreSQL 16)', () => {
  let container: StartedPostgreSqlContainer;
  let dbConnection: ReturnType<typeof getPaymentDb>;
  let app: FastifyInstance;
  let pspClient: MockPspClient;
  let ledger: DoubleEntryLedger;
  let sagaService: PaymentSagaService;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16')
      .withDatabase('payment')
      .withUsername('hex')
      .withPassword('hex_dev_only')
      .start();

    const connectionUri = container.getConnectionUri();
    await runMigrations(connectionUri);

    dbConnection = getPaymentDb(connectionUri);
    pspClient = new MockPspClient();
    ledger = new DoubleEntryLedger(dbConnection.db);
    sagaService = new PaymentSagaService({
      db: dbConnection.db,
      pspClient,
      ledger,
    });
    const reconciliationService = new ReconciliationService(dbConnection.db);

    app = withInternalAuth(
      await buildPaymentApp({
        db: dbConnection.db,
        pspClient,
        sagaService,
        reconciliationService,
        ledger,
        logLevel: 'silent',
      }),
    );
  }, 60000);

  afterAll(async () => {
    if (dbConnection) {
      await assertLedgerInvariant(dbConnection.db);
      await dbConnection.close();
    }
    if (app) await app.close();
    if (container) await container.stop();
  });

  it('completes full payment lifecycle and reconciles cleanly on real PostgreSQL', async () => {
    const rideId = 'ride-container-test';
    await sagaService.startAuthorizeSaga(rideId, 5000);
    await sagaService.startCaptureSaga(rideId, 5000, 'drv-container');

    const res = await app.inject({
      method: 'GET',
      url: `/rides/${rideId}/payment`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().payment.status).toBe('CAPTURED');
  });
});
