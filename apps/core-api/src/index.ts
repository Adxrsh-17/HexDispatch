import { Kafka } from 'kafkajs';
import { loadServiceEnv, startServer, KafkaProducer } from '@hexdispatch/shared';
import { getCoreDb } from './db/index';
import { buildCoreApiApp } from './app';
import { OutboxRelay } from './services/outbox-relay';

const env = loadServiceEnv('CORE_API_PORT', 3001);
const { db, client } = getCoreDb();

const app = await buildCoreApiApp({ db, logLevel: env.LOG_LEVEL });

// Outbox relay setup
const kafkaBrokers = (process.env.KAFKA_BROKERS ?? 'localhost:19092').split(',');
const kafka = new Kafka({
  clientId: 'core-api-relay',
  brokers: kafkaBrokers,
});
const producer = new KafkaProducer(kafka, undefined);
const outboxRelay = new OutboxRelay(db, producer);

try {
  outboxRelay.start(1000);
} catch (err) {
  app.log.warn(
    { err },
    'Could not start outbox relay with live Kafka; running without Kafka publisher',
  );
}

app.addHook('onClose', async () => {
  outboxRelay.stop();
  await producer.disconnect().catch(() => {});
  await client.end().catch(() => {});
});

await startServer(app, { host: env.HOST, port: env.PORT });
