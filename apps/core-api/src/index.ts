import { buildServer, loadServiceEnv, startServer } from '@hexdispatch/shared';

const env = loadServiceEnv('CORE_API_PORT', 3001);
const app = buildServer({ service: 'core-api', logLevel: env.LOG_LEVEL });

await startServer(app, { host: env.HOST, port: env.PORT });
