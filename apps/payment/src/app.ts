import type { FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { eq, desc, sql } from 'drizzle-orm';
import { z } from 'zod';
import { buildServer } from '@hexdispatch/shared';
import { ledgerEntries, payouts, type Payout } from './db/schema';
import { DoubleEntryLedger } from './ledger/double-entry';
import { MockPspClient } from './psp/mock-psp';
import { PaymentSagaService } from './services/payment-saga';
import { ReconciliationService } from './services/reconciliation';

export interface BuildPaymentAppOptions {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle db
  db: any;
  pspClient?: MockPspClient;
  sagaService?: PaymentSagaService;
  reconciliationService?: ReconciliationService;
  ledger?: DoubleEntryLedger;
  logLevel?: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';
}

export async function buildPaymentApp(options: BuildPaymentAppOptions): Promise<FastifyInstance> {
  const app = buildServer({
    service: 'payment',
    logLevel: options.logLevel ?? 'info',
  });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  const typedApp = app.withTypeProvider<ZodTypeProvider>();

  const pspClient = options.pspClient ?? new MockPspClient();
  const ledger = options.ledger ?? new DoubleEntryLedger(options.db);
  const sagaService =
    options.sagaService ??
    new PaymentSagaService({
      db: options.db,
      pspClient,
      ledger,
    });
  const reconciliationService =
    options.reconciliationService ?? new ReconciliationService(options.db);

  // --- Payment Inquiry ---

  typedApp.get(
    '/rides/:id/payment',
    {
      schema: {
        params: z.object({
          id: z.string(),
        }),
      },
    },
    async (request, reply) => {
      const { id: rideId } = request.params;
      const { payment, saga } = await sagaService.getPaymentByRideId(rideId);

      const entries = await options.db
        .select()
        .from(ledgerEntries)
        .where(eq(ledgerEntries.rideId, rideId))
        .orderBy(desc(ledgerEntries.ts));

      return reply.send({
        rideId,
        payment,
        saga,
        ledgerEntries: entries,
      });
    },
  );

  // --- Admin: Reconciliation ---

  typedApp.post('/admin/reconcile', async (_request, reply) => {
    const report = await reconciliationService.runReconciliation();
    return reply.send(report);
  });

  // --- Admin: Payment Retry ---

  typedApp.post(
    '/admin/payments/:id/retry',
    {
      schema: {
        params: z.object({
          id: z.string(),
        }),
      },
    },
    async (request, reply) => {
      const { id: rideId } = request.params;
      const updatedSaga = await sagaService.retryPayment(rideId);
      return reply.send({
        success: true,
        saga: updatedSaga,
      });
    },
  );

  // --- Admin: Compensating Refund ---

  typedApp.post(
    '/admin/refunds/:rideId',
    {
      schema: {
        params: z.object({
          rideId: z.string(),
        }),
        body: z.object({
          reason: z.string().default('ADMIN_REFUND'),
        }),
      },
    },
    async (request, reply) => {
      const { rideId } = request.params;
      const { reason } = request.body;
      await sagaService.refundPayment(rideId, reason);
      return reply.send({
        success: true,
        rideId,
        refunded: true,
      });
    },
  );

  // --- Admin: Driver Payout Batching (Task 6) ---

  typedApp.post(
    '/admin/payouts/batch',
    {
      schema: {
        body: z.object({
          driverId: z.string().optional(),
        }),
      },
    },
    async (_request, reply) => {
      // Find driver payables from ledger that haven't been paid out yet
      const rows = await options.db
        .select({
          driverId: ledgerEntries.driverId,
          totalPayable: sql<number>`sum(${ledgerEntries.credit}) - sum(${ledgerEntries.debit})`,
        })
        .from(ledgerEntries)
        .where(eq(ledgerEntries.account, 'driver_payable'))
        .groupBy(ledgerEntries.driverId);

      const createdPayouts: Payout[] = [];

      for (const row of rows) {
        if (!row.driverId) continue;
        const payable = Number(row.totalPayable);
        if (payable <= 0) continue;

        const payoutId = crypto.randomUUID();
        const statementId = `stmt_${Date.now()}_${row.driverId.slice(0, 6)}`;

        const [payout] = await options.db
          .insert(payouts)
          .values({
            id: payoutId,
            driverId: row.driverId,
            amountMinorUnits: payable,
            currency: 'INR',
            status: 'PAID',
            statementId,
            createdAt: new Date(),
            updatedAt: new Date(),
          })
          .returning();

        // Record payout in double-entry ledger
        await ledger.recordDriverPayout({
          payoutId,
          driverId: row.driverId,
          amountMinorUnits: payable,
        });

        createdPayouts.push(payout!);
      }

      return reply.send({
        success: true,
        payouts: createdPayouts,
      });
    },
  );

  return app;
}
