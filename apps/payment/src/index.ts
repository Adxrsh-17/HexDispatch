import { buildServer, loadServiceEnv, startServer } from '@hexdispatch/shared';

const env = loadServiceEnv('PAYMENT_PORT', 3005);
const app = buildServer({ service: 'payment', logLevel: env.LOG_LEVEL });

await startServer(app, { host: env.HOST, port: env.PORT });
