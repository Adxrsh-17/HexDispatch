import Redis from 'ioredis';
import { loadServiceEnv, startServer } from '@hexdispatch/shared';
import { buildGatewayApp } from './app';

const env = loadServiceEnv('GATEWAY_PORT', 3000);
const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
const redisPub = new Redis(redisUrl, { lazyConnect: true });
const redisSub = new Redis(redisUrl, { lazyConnect: true });

try {
  await Promise.all([redisPub.connect(), redisSub.connect()]);
} catch (err) {
  console.warn('Could not connect to Redis at startup; continuing with in-memory fallback', err);
}

const app = await buildGatewayApp({
  coreApiUrl: process.env.CORE_API_URL ?? 'http://localhost:3001',
  redisClient: redisPub,
  redisSubClient: redisSub,
  logLevel: env.LOG_LEVEL,
});

app.addHook('onClose', async () => {
  if (redisPub.status === 'ready') await redisPub.quit().catch(() => {});
  if (redisSub.status === 'ready') await redisSub.quit().catch(() => {});
});

await startServer(app, { host: env.HOST, port: env.PORT });
