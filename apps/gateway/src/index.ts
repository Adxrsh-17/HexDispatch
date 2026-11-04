import Redis from 'ioredis';
import { loadServiceEnv, startServer } from '@hexdispatch/shared';
import { buildGatewayApp } from './app';

const env = loadServiceEnv('GATEWAY_PORT', 3000);
const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
const redis = new Redis(redisUrl, { lazyConnect: true });

try {
  await redis.connect();
} catch (err) {
  console.warn(
    'Could not connect to Redis at startup; continuing with in-memory rate limiting fallback',
    err,
  );
}

const app = buildGatewayApp({
  coreApiUrl: process.env.CORE_API_URL ?? 'http://localhost:3001',
  redisClient: redis,
  logLevel: env.LOG_LEVEL,
});

app.addHook('onClose', async () => {
  if (redis.status === 'ready') {
    await redis.quit().catch(() => {});
  }
});

await startServer(app, { host: env.HOST, port: env.PORT });
