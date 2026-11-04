import { buildServer, loadServiceEnv, startServer } from '@hexdispatch/shared';

const env = loadServiceEnv('DISPATCH_PORT', 3003);
const app = buildServer({ service: 'dispatch', logLevel: env.LOG_LEVEL });

await startServer(app, { host: env.HOST, port: env.PORT });
