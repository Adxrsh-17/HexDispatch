import { buildServer, loadServiceEnv, startServer } from '@hexdispatch/shared';

const env = loadServiceEnv('PRICING_PORT', 3004);
const app = buildServer({ service: 'pricing', logLevel: env.LOG_LEVEL });

await startServer(app, { host: env.HOST, port: env.PORT });
