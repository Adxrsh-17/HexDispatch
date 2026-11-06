import Redis from 'ioredis';
import { Kafka } from 'kafkajs';
import { loadServiceEnv, startServer, KafkaProducer, KafkaConsumer } from '@hexdispatch/shared';
import { TOPICS, type RideRequestedEvent } from '@hexdispatch/contracts';
import { getDispatchDb } from './db/index';
import { DriverClaimService } from './services/driver-claim';
import { MatchingRegistry } from './services/matching-registry';
import { OfferManager } from './services/offer-manager';
import { DispatchEngine } from './services/dispatch-engine';
import { buildDispatchApp } from './app';

const env = loadServiceEnv('DISPATCH_PORT', 3003);
const { db, close: closeDb } = getDispatchDb();

const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
const redis = new Redis(redisUrl, { lazyConnect: true });

try {
  await redis.connect();
} catch (err) {
  console.warn('Could not connect to Redis at startup; running in degraded mode', err);
}

const kafkaBrokers = (process.env.KAFKA_BROKERS ?? 'localhost:19092').split(',');
const kafka = new Kafka({
  clientId: 'dispatch-service',
  brokers: kafkaBrokers,
});
const producer = new KafkaProducer(kafka, undefined);

const claimService = new DriverClaimService(redis);
const matchingRegistry = new MatchingRegistry();

// eslint-disable-next-line prefer-const -- Initialized below after offerManager
let dispatchEngine: DispatchEngine;

const offerManager = new OfferManager({
  db,
  redis,
  claimService,
  producer,
  coreApiUrl: process.env.CORE_API_URL ?? 'http://localhost:3001',
  gatewayBroadcastUrl: process.env.GATEWAY_URL ?? 'http://localhost:3000',
  redisPubSub: redis,
  defaultOfferTimeoutSec: Number(process.env.OFFER_TIMEOUT_SEC ?? 15),
  onRideGone: (rideId) => dispatchEngine?.dropRide(rideId),
  onReofferNeeded: async (rideId, excludedDriverId) => {
    if (dispatchEngine) {
      await dispatchEngine.handleReofferNeeded(rideId, excludedDriverId);
    }
  },
});

dispatchEngine = new DispatchEngine({
  db,
  offerManager,
  matchingRegistry,
  claimService,
  coreApiUrl: process.env.CORE_API_URL ?? 'http://localhost:3001',
  locationUrl: process.env.LOCATION_URL ?? 'http://localhost:3002',
  gatewayBroadcastUrl: process.env.GATEWAY_URL ?? 'http://localhost:3000',
  redisPubSub: redis,
  matchingPolicy: process.env.MATCHING_POLICY ?? 'greedy',
  maxOfferAttempts: Number(process.env.MAX_OFFER_ATTEMPTS ?? 3),
  batchWindowMs: Number(process.env.BATCH_WINDOW_MS ?? 2000),
  batchLagFallbackMs: Number(process.env.BATCH_LAG_FALLBACK_MS ?? 5000),
  matchingTimeoutMs: Number(process.env.MATCHING_TIMEOUT_SEC ?? 60) * 1000,
  batchSolveBudgetMs: Number(process.env.BATCH_SOLVE_BUDGET_MS ?? 1500),
  h3MatcherOwnerRes: Number(process.env.H3_MATCHER_OWNER_RES ?? 6),
  producer,
});

// Task 8: Startup Recovery of Pending Offers
try {
  const recovery = await offerManager.recoverPendingOffers();
  console.log(
    `Dispatch startup recovery: ${recovery.recoveredCount} offers re-armed, ${recovery.expiredCount} expired`,
  );
} catch (err) {
  console.warn('Failed to recover pending offers at startup:', err);
}

// Recover rides that core-api still has in REQUESTED/MATCHING (restart or crash while pending)
try {
  const pending = await dispatchEngine.recoverPendingRides();
  console.log(`Dispatch startup recovery: ${pending.recovered} pending rides re-queued`);
} catch (err) {
  console.warn('Failed to recover pending rides at startup:', err);
}

// Kafka Consumer for ride.requested (Task 1)
const consumer = new KafkaConsumer(kafka, 'dispatch-group', producer);
try {
  await consumer.subscribe<RideRequestedEvent>([TOPICS.RIDE_REQUESTED], async (event) => {
    await dispatchEngine.handleRideRequested(event);
  });
} catch (err) {
  console.warn('Could not connect Kafka consumer at startup; continuing...', err);
}

const app = await buildDispatchApp({
  offerManager,
  dispatchEngine,
  logLevel: env.LOG_LEVEL,
});

app.addHook('onClose', async () => {
  dispatchEngine.stop();
  offerManager.stop();
  await consumer.disconnect().catch(() => {});
  await producer.disconnect().catch(() => {});
  if (redis.status === 'ready') await redis.quit().catch(() => {});
  await closeDb();
});

await startServer(app, { host: env.HOST, port: env.PORT });
