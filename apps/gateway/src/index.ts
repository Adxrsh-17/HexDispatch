import { buildServer, loadServiceEnv, startServer } from '@hexdispatch/shared';

const env = loadServiceEnv('GATEWAY_PORT', 3000);
const app = buildServer({ service: 'gateway', logLevel: env.LOG_LEVEL });

await startServer(app, { host: env.HOST, port: env.PORT });
