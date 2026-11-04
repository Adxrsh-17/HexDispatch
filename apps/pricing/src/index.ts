import Redis from 'ioredis';
import { Kafka } from 'kafkajs';
import { loadServiceEnv, startServer, KafkaProducer, KafkaConsumer } from '@hexdispatch/shared';
import { TOPICS, type RideRequestedEvent } from '@hexdispatch/contracts';
import { getPricingDb } from './db/index';
import { PricingService } from './services/pricing-service';
import { buildPricingApp } from './app';

const env = loadServiceEnv('PRICING_PORT', 3004);
const { db, close: closeDb } = getPricingDb();

const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
const redis = new Redis(redisUrl, { lazyConnect: true });

try {
  await redis.connect();
} catch (err) {
  console.warn('Could not connect to Redis at startup; running in degraded mode', err);
}

const kafkaBrokers = (process.env.KAFKA_BROKERS ?? 'localhost:19092').split(',');
const kafka = new Kafka({
  clientId: 'pricing-service',
  brokers: kafkaBrokers,
});
const producer = new KafkaProducer(kafka, undefined);

const pricingService = new PricingService({
  db,
  redis,
  quoteTtlSec: Number(process.env.QUOTE_TTL_SEC ?? 300),
  surgeIntervalSec: Number(process.env.SURGE_INTERVAL_SEC ?? 30),
  locationUrl: process.env.LOCATION_URL ?? 'http://localhost:3002',
  redisPubSub: redis,
  producer,
});

pricingService.startSurgeLoop();

// Kafka Consumer for ride.requested to update sliding window demand (Task 3)
const consumer = new KafkaConsumer(kafka, 'pricing-group', producer);
try {
  await consumer.subscribe<RideRequestedEvent>([TOPICS.RIDE_REQUESTED], async (event) => {
    const cell =
      event.payload.pickupCell ||
      pricingService.getCellForPoint(event.payload.pickup.lat, event.payload.pickup.lng);
    await pricingService.recordDemandEvent(cell, new Date(event.payload.requestedAt).getTime());
  });
} catch (err) {
  console.warn('Could not connect Kafka consumer at startup; continuing...', err);
}

const app = await buildPricingApp({
  pricingService,
  logLevel: env.LOG_LEVEL,
});

app.addHook('onClose', async () => {
  pricingService.stop();
  await consumer.disconnect().catch(() => {});
  await producer.disconnect().catch(() => {});
  if (redis.status === 'ready') await redis.quit().catch(() => {});
  await closeDb();
});

await startServer(app, { host: env.HOST, port: env.PORT });
