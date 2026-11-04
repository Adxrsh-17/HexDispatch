import { randomUUID } from 'node:crypto';
import { eq, sql, or } from 'drizzle-orm';
import { Counter, type Registry } from 'prom-client';
import { TOPICS, type TripStateChangedEvent } from '@hexdispatch/contracts';
import { AppError } from '@hexdispatch/shared';
import {
  payments,
  paymentSagas,
  pspRecords,
  processedEvents,
  type Payment,
  type PaymentSaga,
} from '../db/schema';
import type { DoubleEntryLedger } from '../ledger/double-entry';
import type { MockPspClient } from '../psp/mock-psp';

interface SagaPayloadData {
  amountMinorUnits?: number;
  driverId?: string;
  reason?: string;
  cancellationFeeMinorUnits?: number;
}

export interface PaymentSagaOptions {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle db
  db: any;
  pspClient: MockPspClient;
  ledger: DoubleEntryLedger;
  producer?: {
    publish: (topic: string, key: string, payload: unknown) => Promise<void>;
  };
  metricsRegistry?: Registry;
  platformFeeRate?: number;
}

export class PaymentSagaService {
  private platformFeeRate: number;
  readonly authorizedCounter: Counter<string>;
  readonly capturedCounter: Counter<string>;
  readonly failedCounter: Counter<string>;
  readonly refundedCounter: Counter<string>;

  constructor(private options: PaymentSagaOptions) {
    this.platformFeeRate = options.platformFeeRate ?? 0.2; // 20% platform take rate

    const reg = options.metricsRegistry;
    this.authorizedCounter = new Counter({
      name: 'payment_authorized_total',
      help: 'Total payments authorized',
      registers: reg ? [reg] : [],
    });
    this.capturedCounter = new Counter({
      name: 'payment_captured_total',
      help: 'Total payments captured',
      registers: reg ? [reg] : [],
    });
    this.failedCounter = new Counter({
      name: 'payment_failed_total',
      help: 'Total payments failed',
      registers: reg ? [reg] : [],
    });
    this.refundedCounter = new Counter({
      name: 'payment_refunded_total',
      help: 'Total payments refunded',
      registers: reg ? [reg] : [],
    });
  }

  // --- Idempotent Event Consumer Entrypoint ---

  async handleTripStateChanged(event: TripStateChangedEvent): Promise<void> {
    const { eventId, payload } = event;
    const { rideId, to } = payload;

    // 1. Natural & Event Deduplication
    const isProcessed = await this.markEventProcessed(eventId, 'payment_consumer');
    if (isProcessed) {
      // Event already processed
      return;
    }

    const rawPayload = payload as Record<string, unknown>;
    switch (to) {
      case 'ASSIGNED': {
        const estimatedFare = Number(
          rawPayload.fareEstimate ?? rawPayload.fareQuoteMinorUnits ?? 50000,
        );
        await this.startAuthorizeSaga(rideId, estimatedFare);
        break;
      }
      case 'COMPLETED': {
        const finalFare = Number(
          rawPayload.fareFinal ?? rawPayload.fareMinorUnits ?? rawPayload.fareEstimate ?? 50000,
        );
        const driverId = rawPayload.driverId as string | undefined;
        await this.startCaptureSaga(rideId, finalFare, driverId);
        break;
      }
      case 'CANCELLED_BY_RIDER':
      case 'CANCELLED_BY_DRIVER': {
        const reason = (rawPayload.reason as string | undefined) ?? to;
        const fee = Number(rawPayload.cancellationFeeMinorUnits ?? 0);
        await this.startCancellationSaga(rideId, reason, fee);
        break;
      }
      default:
        // Other state transitions (REQUESTED, ARRIVED, IN_PROGRESS) don't require payment actions
        break;
    }
  }

  private async markEventProcessed(eventId: string, consumer: string): Promise<boolean> {
    const rows = await this.options.db
      .insert(processedEvents)
      .values({
        eventId,
        consumer,
        processedAt: new Date(),
      })
      .onConflictDoNothing()
      .returning();

    return rows.length === 0;
  }

  // --- Saga: Authorize Step ---

  async startAuthorizeSaga(rideId: string, amountMinorUnits: number): Promise<void> {
    // 1. Upsert saga row in state PENDING
    await this.options.db
      .insert(paymentSagas)
      .values({
        rideId,
        step: 'AUTHORIZE',
        state: 'PENDING',
        attempts: 0,
        payload: { amountMinorUnits },
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: paymentSagas.rideId,
        set: {
          step: 'AUTHORIZE',
          state: 'PENDING',
          payload: { amountMinorUnits },
          updatedAt: new Date(),
        },
      });

    await this.executeAuthorizeStep(rideId, amountMinorUnits);
  }

  private async executeAuthorizeStep(rideId: string, amountMinorUnits: number): Promise<void> {
    const idempotencyKey = `auth:${rideId}`;

    // Mark saga EXECUTING
    await this.options.db
      .update(paymentSagas)
      .set({
        state: 'EXECUTING',
        attempts: sql`${paymentSagas.attempts} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(paymentSagas.rideId, rideId));

    try {
      let authRes;
      try {
        authRes = await this.options.pspClient.authorize({
          idempotencyKey,
          rideId,
          amountMinorUnits,
        });
      } catch (err: unknown) {
        const error = err as Error & { code?: string };
        // If timeout error, query PSP with same idempotencyKey to resolve outcome
        if (error.code === 'ETIMEDOUT' || error.message?.includes('Timeout')) {
          const queried = await this.options.pspClient.queryByIdempotencyKey(idempotencyKey);
          if (queried && queried.status === 'SUCCESS') {
            authRes = {
              pspRef: queried.pspRef,
              idempotencyKey,
              status: 'AUTHORIZED' as const,
              amountMinorUnits: queried.amountMinorUnits,
            };
          } else {
            throw err;
          }
        } else {
          throw err;
        }
      }

      if (authRes.status === 'FAILED') {
        throw new Error(`PSP declined authorization for ride ${rideId}`);
      }

      // Record in payments table
      const paymentId = randomUUID();
      await this.options.db
        .insert(payments)
        .values({
          id: paymentId,
          rideId,
          status: 'AUTHORIZED',
          amountMinorUnits,
          currency: 'INR',
          pspRef: authRes.pspRef,
          idempotencyKey,
          metadata: { authorizedAt: new Date().toISOString() },
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: payments.idempotencyKey,
          set: {
            status: 'AUTHORIZED',
            pspRef: authRes.pspRef,
            updatedAt: new Date(),
          },
        });

      // Record in psp_records
      await this.options.db
        .insert(pspRecords)
        .values({
          id: randomUUID(),
          pspRef: authRes.pspRef,
          rideId,
          idempotencyKey,
          kind: 'AUTHORIZATION',
          amountMinorUnits,
          status: 'SUCCESS',
          ts: new Date(),
        })
        .onConflictDoNothing();

      // Mark saga COMPLETED
      await this.options.db
        .update(paymentSagas)
        .set({
          state: 'COMPLETED',
          updatedAt: new Date(),
        })
        .where(eq(paymentSagas.rideId, rideId));

      this.authorizedCounter.inc();

      if (this.options.producer) {
        await this.options.producer.publish(TOPICS.PAYMENT_AUTHORIZED, rideId, {
          eventId: randomUUID(),
          rideId,
          pspRef: authRes.pspRef,
          amountMinorUnits,
          occurredAt: new Date().toISOString(),
        });
      }
    } catch (err: unknown) {
      await this.handleSagaFailure(rideId, 'AUTHORIZE', err);
    }
  }

  // --- Saga: Capture Step ---

  async startCaptureSaga(
    rideId: string,
    amountMinorUnits: number,
    driverId?: string,
  ): Promise<void> {
    await this.options.db
      .insert(paymentSagas)
      .values({
        rideId,
        step: 'CAPTURE',
        state: 'PENDING',
        attempts: 0,
        payload: { amountMinorUnits, driverId },
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: paymentSagas.rideId,
        set: {
          step: 'CAPTURE',
          state: 'PENDING',
          payload: { amountMinorUnits, driverId },
          updatedAt: new Date(),
        },
      });

    await this.executeCaptureStep(rideId, amountMinorUnits, driverId);
  }

  private async executeCaptureStep(
    rideId: string,
    amountMinorUnits: number,
    driverId?: string,
  ): Promise<void> {
    const idempotencyKey = `capture:${rideId}`;

    await this.options.db
      .update(paymentSagas)
      .set({
        state: 'EXECUTING',
        attempts: sql`${paymentSagas.attempts} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(paymentSagas.rideId, rideId));

    try {
      // Find existing authorized payment
      const [existingPayment] = await this.options.db
        .select()
        .from(payments)
        .where(eq(payments.rideId, rideId))
        .limit(1);

      if (!existingPayment || !existingPayment.pspRef) {
        throw new Error(`Cannot capture: no authorized payment found for ride ${rideId}`);
      }

      let captureRes;
      try {
        captureRes = await this.options.pspClient.capture({
          idempotencyKey,
          pspRef: existingPayment.pspRef,
          amountMinorUnits,
        });
      } catch (err: unknown) {
        const error = err as Error & { code?: string };
        // If timeout, query PSP by key to verify if capture landed
        if (error.code === 'ETIMEDOUT' || error.message?.includes('Timeout')) {
          const queried = await this.options.pspClient.queryByIdempotencyKey(idempotencyKey);
          if (queried && queried.status === 'SUCCESS') {
            captureRes = {
              pspRef: queried.pspRef,
              idempotencyKey,
              status: 'CAPTURED' as const,
              amountMinorUnits: queried.amountMinorUnits,
            };
          } else {
            throw err;
          }
        } else {
          throw err;
        }
      }

      if (captureRes.status === 'FAILED') {
        throw new Error(`PSP capture failed for ride ${rideId}`);
      }

      // Update payments table to CAPTURED
      await this.options.db
        .update(payments)
        .set({
          status: 'CAPTURED',
          amountMinorUnits,
          updatedAt: new Date(),
        })
        .where(eq(payments.id, existingPayment.id));

      // Append PSP record
      await this.options.db
        .insert(pspRecords)
        .values({
          id: randomUUID(),
          pspRef: `cap_${existingPayment.pspRef}`,
          rideId,
          idempotencyKey,
          kind: 'CAPTURE',
          amountMinorUnits,
          status: 'SUCCESS',
          ts: new Date(),
        })
        .onConflictDoNothing();

      // Post balanced ledger entries atomically
      await this.options.ledger.recordRideSettlement({
        rideId,
        driverId,
        fareMinorUnits: amountMinorUnits,
        platformFeeRate: this.platformFeeRate,
      });

      // Mark saga COMPLETED
      await this.options.db
        .update(paymentSagas)
        .set({
          state: 'COMPLETED',
          updatedAt: new Date(),
        })
        .where(eq(paymentSagas.rideId, rideId));

      this.capturedCounter.inc();

      if (this.options.producer) {
        await this.options.producer.publish(TOPICS.PAYMENT_CAPTURED, rideId, {
          eventId: randomUUID(),
          rideId,
          pspRef: existingPayment.pspRef,
          amountMinorUnits,
          occurredAt: new Date().toISOString(),
        });
      }
    } catch (err: unknown) {
      await this.handleSagaFailure(rideId, 'CAPTURE', err);
    }
  }

  // --- Saga: Cancellation & Release Step ---

  async startCancellationSaga(
    rideId: string,
    reason: string,
    cancellationFeeMinorUnits = 0,
  ): Promise<void> {
    await this.options.db
      .insert(paymentSagas)
      .values({
        rideId,
        step: 'RELEASE',
        state: 'PENDING',
        attempts: 0,
        payload: { reason, cancellationFeeMinorUnits },
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: paymentSagas.rideId,
        set: {
          step: 'RELEASE',
          state: 'PENDING',
          payload: { reason, cancellationFeeMinorUnits },
          updatedAt: new Date(),
        },
      });

    await this.executeReleaseStep(rideId, cancellationFeeMinorUnits);
  }

  private async executeReleaseStep(
    rideId: string,
    cancellationFeeMinorUnits: number,
  ): Promise<void> {
    const idempotencyKey = `release:${rideId}`;

    await this.options.db
      .update(paymentSagas)
      .set({
        state: 'EXECUTING',
        attempts: sql`${paymentSagas.attempts} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(paymentSagas.rideId, rideId));

    try {
      const [existingPayment] = await this.options.db
        .select()
        .from(payments)
        .where(eq(payments.rideId, rideId))
        .limit(1);

      if (existingPayment && existingPayment.status === 'AUTHORIZED' && existingPayment.pspRef) {
        await this.options.pspClient.release({
          idempotencyKey,
          pspRef: existingPayment.pspRef,
        });

        await this.options.db
          .update(payments)
          .set({
            status: 'RELEASED',
            updatedAt: new Date(),
          })
          .where(eq(payments.id, existingPayment.id));

        await this.options.db
          .insert(pspRecords)
          .values({
            id: randomUUID(),
            pspRef: `rel_${existingPayment.pspRef}`,
            rideId,
            idempotencyKey,
            kind: 'RELEASE',
            amountMinorUnits: existingPayment.amountMinorUnits,
            status: 'SUCCESS',
            ts: new Date(),
          })
          .onConflictDoNothing();
      }

      // If a cancellation fee applies, capture and record fee
      if (cancellationFeeMinorUnits > 0) {
        await this.options.ledger.recordCancellationFee({
          rideId,
          feeMinorUnits: cancellationFeeMinorUnits,
        });
      }

      await this.options.db
        .update(paymentSagas)
        .set({
          state: 'COMPLETED',
          updatedAt: new Date(),
        })
        .where(eq(paymentSagas.rideId, rideId));
    } catch (err: unknown) {
      await this.handleSagaFailure(rideId, 'RELEASE', err);
    }
  }

  // --- Saga: Compensating Refund Step ---

  async refundPayment(rideId: string, reason = 'CUSTOMER_REFUND'): Promise<void> {
    const idempotencyKey = `refund:${rideId}`;

    const [payment] = await this.options.db
      .select()
      .from(payments)
      .where(eq(payments.rideId, rideId))
      .limit(1);

    if (!payment || payment.status !== 'CAPTURED' || !payment.pspRef) {
      throw AppError.badRequest(`Cannot refund ride ${rideId}: not in CAPTURED status`);
    }

    const refundRes = await this.options.pspClient.refund({
      idempotencyKey,
      pspRef: payment.pspRef,
      amountMinorUnits: payment.amountMinorUnits,
    });

    if (refundRes.status === 'FAILED') {
      throw AppError.unavailable(`PSP failed refund for ride ${rideId}`);
    }

    // Update payment row
    await this.options.db
      .update(payments)
      .set({
        status: 'REFUNDED',
        updatedAt: new Date(),
      })
      .where(eq(payments.id, payment.id));

    // Append psp record
    await this.options.db
      .insert(pspRecords)
      .values({
        id: randomUUID(),
        pspRef: refundRes.refundRef,
        rideId,
        idempotencyKey,
        kind: 'REFUND',
        amountMinorUnits: payment.amountMinorUnits,
        status: 'SUCCESS',
        ts: new Date(),
      })
      .onConflictDoNothing();

    // Post balanced double-entry refund entries
    await this.options.ledger.recordRideRefund({
      rideId,
      fareMinorUnits: payment.amountMinorUnits,
      platformFeeRate: this.platformFeeRate,
    });

    this.refundedCounter.inc();

    if (this.options.producer) {
      await this.options.producer.publish(TOPICS.PAYMENT_REFUNDED, rideId, {
        eventId: randomUUID(),
        rideId,
        refundRef: refundRes.refundRef,
        amountMinorUnits: payment.amountMinorUnits,
        reason,
        occurredAt: new Date().toISOString(),
      });
    }
  }

  // --- Error & Dead-Letter Handling ---

  private async handleSagaFailure(rideId: string, step: string, err: unknown): Promise<void> {
    const [saga] = await this.options.db
      .select()
      .from(paymentSagas)
      .where(eq(paymentSagas.rideId, rideId))
      .limit(1);

    const attempts = saga?.attempts ?? 1;
    const maxAttempts = saga?.maxAttempts ?? 5;
    const errorMessage = err instanceof Error ? err.message : String(err);

    if (attempts >= maxAttempts) {
      // Mark FAILED and push to DLQ
      await this.options.db
        .update(paymentSagas)
        .set({
          state: 'FAILED',
          lastError: errorMessage,
          updatedAt: new Date(),
        })
        .where(eq(paymentSagas.rideId, rideId));

      this.failedCounter.inc();

      if (this.options.producer) {
        await this.options.producer.publish('dlq.payment', rideId, {
          rideId,
          step,
          attempts,
          error: errorMessage,
          failedAt: new Date().toISOString(),
        });
        await this.options.producer.publish(TOPICS.PAYMENT_FAILED, rideId, {
          rideId,
          step,
          error: errorMessage,
          occurredAt: new Date().toISOString(),
        });
      }
    } else {
      // Keep state PENDING so retries can pick it up
      await this.options.db
        .update(paymentSagas)
        .set({
          state: 'PENDING',
          lastError: errorMessage,
          updatedAt: new Date(),
        })
        .where(eq(paymentSagas.rideId, rideId));
    }
  }

  // --- Recovery & Pending Saga Resumption (AC4) ---

  async resumePendingSagas(): Promise<number> {
    const pendingSagas = await this.options.db
      .select()
      .from(paymentSagas)
      .where(or(eq(paymentSagas.state, 'PENDING'), eq(paymentSagas.state, 'EXECUTING')));

    let resumedCount = 0;
    for (const saga of pendingSagas) {
      const payload = saga.payload as SagaPayloadData | null;
      if (saga.step === 'AUTHORIZE' && payload?.amountMinorUnits) {
        await this.executeAuthorizeStep(saga.rideId, payload.amountMinorUnits);
        resumedCount++;
      } else if (saga.step === 'CAPTURE' && payload?.amountMinorUnits) {
        await this.executeCaptureStep(saga.rideId, payload.amountMinorUnits, payload?.driverId);
        resumedCount++;
      } else if (saga.step === 'RELEASE') {
        await this.executeReleaseStep(saga.rideId, payload?.cancellationFeeMinorUnits ?? 0);
        resumedCount++;
      }
    }

    return resumedCount;
  }

  async retryPayment(rideId: string): Promise<PaymentSaga> {
    const [saga] = await this.options.db
      .select()
      .from(paymentSagas)
      .where(eq(paymentSagas.rideId, rideId))
      .limit(1);

    if (!saga) {
      throw AppError.notFound(`No saga found for ride ${rideId}`);
    }

    // Reset attempts and set state to PENDING
    const [updated] = await this.options.db
      .update(paymentSagas)
      .set({
        state: 'PENDING',
        attempts: 0,
        lastError: null,
        updatedAt: new Date(),
      })
      .where(eq(paymentSagas.rideId, rideId))
      .returning();

    const payload = saga.payload as SagaPayloadData | null;
    if (saga.step === 'AUTHORIZE' && payload?.amountMinorUnits) {
      await this.executeAuthorizeStep(saga.rideId, payload.amountMinorUnits);
    } else if (saga.step === 'CAPTURE' && payload?.amountMinorUnits) {
      await this.executeCaptureStep(saga.rideId, payload.amountMinorUnits, payload?.driverId);
    }

    return updated!;
  }

  async getPaymentByRideId(rideId: string): Promise<{
    payment: Payment | null;
    saga: PaymentSaga | null;
  }> {
    const [payment] = await this.options.db
      .select()
      .from(payments)
      .where(eq(payments.rideId, rideId))
      .limit(1);

    const [saga] = await this.options.db
      .select()
      .from(paymentSagas)
      .where(eq(paymentSagas.rideId, rideId))
      .limit(1);

    return {
      payment: payment ?? null,
      saga: saga ?? null,
    };
  }
}
