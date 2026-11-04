import { Kafka } from 'kafkajs';
import { loadServiceEnv, startServer, KafkaProducer, KafkaConsumer } from '@hexdispatch/shared';
import { TOPICS, type TripStateChangedEvent } from '@hexdispatch/contracts';
import { getPaymentDb } from './db/index';
import { DoubleEntryLedger } from './ledger/double-entry';
import { MockPspClient } from './psp/mock-psp';
import { PaymentSagaService } from './services/payment-saga';
import { ReconciliationService } from './services/reconciliation';
import { buildPaymentApp } from './app';

const env = loadServiceEnv('PAYMENT_PORT', 3005);
const { db, close: closeDb } = getPaymentDb();

const kafkaBrokers = (process.env.KAFKA_BROKERS ?? 'localhost:19092').split(',');
const kafka = new Kafka({
  clientId: 'payment-service',
  brokers: kafkaBrokers,
});
const producer = new KafkaProducer(kafka, undefined);

const pspClient = new MockPspClient({
  failureRate: Number(process.env.MOCK_PSP_FAILURE_RATE ?? 0),
  timeoutRate: Number(process.env.MOCK_PSP_TIMEOUT_RATE ?? 0),
  latencyMs: Number(process.env.MOCK_PSP_LATENCY_MS ?? 0),
});
const ledger = new DoubleEntryLedger(db);
const sagaService = new PaymentSagaService({
  db,
  pspClient,
  ledger,
  producer,
  platformFeeRate: Number(process.env.PLATFORM_FEE_RATE ?? 0.2),
});
const reconciliationService = new ReconciliationService(db);

// Resume any pending sagas from before restart (AC4)
sagaService.resumePendingSagas().catch((err) => {
  console.warn('Error resuming pending sagas on startup:', err);
});

// Kafka Consumer for trip.state.changed
const consumer = new KafkaConsumer(kafka, 'payment-group', producer);
try {
  await consumer.subscribe<TripStateChangedEvent>([TOPICS.TRIP_STATE_CHANGED], async (event) => {
    await sagaService.handleTripStateChanged(event);
  });
} catch (err) {
  console.warn('Could not connect Kafka consumer at startup; continuing...', err);
}

const app = await buildPaymentApp({
  db,
  pspClient,
  sagaService,
  reconciliationService,
  ledger,
  logLevel: env.LOG_LEVEL,
});

app.addHook('onClose', async () => {
  await consumer.disconnect().catch(() => {});
  await producer.disconnect().catch(() => {});
  await closeDb();
});

await startServer(app, { host: env.HOST, port: env.PORT });
