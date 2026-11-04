import { buildServer, loadServiceEnv, startServer } from '@hexdispatch/shared';

const env = loadServiceEnv('LOCATION_PORT', 3002);
const app = buildServer({ service: 'location', logLevel: env.LOG_LEVEL });

await startServer(app, { host: env.HOST, port: env.PORT });
