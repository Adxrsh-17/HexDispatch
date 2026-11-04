import Redis from 'ioredis';
import { Kafka } from 'kafkajs';
import { loadServiceEnv, startServer, KafkaProducer } from '@hexdispatch/shared';
import { DriverIndex } from './driver-index';
import { NearbySearch } from './nearby';
import { LocationBatchPublisher } from './batch-publisher';
import { TrustEngine } from './trust/trust-engine';
import { buildLocationApp } from './app';

const env = loadServiceEnv('LOCATION_PORT', 3002);
const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
const redis = new Redis(redisUrl, { lazyConnect: true });

try {
  await redis.connect();
} catch (err) {
  console.warn('Could not connect to Redis at startup; running in degraded mode', err);
}

const kafkaBrokers = (process.env.KAFKA_BROKERS ?? 'localhost:19092').split(',');
const kafka = new Kafka({
  clientId: 'location-service',
  brokers: kafkaBrokers,
});
const producer = new KafkaProducer(kafka, undefined);

const driverIndex = new DriverIndex(redis);
const nearbySearch = new NearbySearch(driverIndex);
const trustEngine = new TrustEngine({
  producer,
});
const batchPublisher = new LocationBatchPublisher(producer, {
  batchSize: 50,
  flushIntervalMs: 200,
});

const app = await buildLocationApp({
  driverIndex,
  nearbySearch,
  batchPublisher,
  trustEngine,
  redisPubSub: redis,
  logLevel: env.LOG_LEVEL,
});

app.addHook('onClose', async () => {
  batchPublisher.stop();
  await batchPublisher.flush();
  await producer.disconnect().catch(() => {});
  if (redis.status === 'ready') await redis.quit().catch(() => {});
});

await startServer(app, { host: env.HOST, port: env.PORT });
