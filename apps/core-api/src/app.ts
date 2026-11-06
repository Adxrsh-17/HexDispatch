import { type FastifyInstance } from 'fastify';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import {
  serializerCompiler,
  validatorCompiler,
  jsonSchemaTransform,
} from 'fastify-type-provider-zod';
import { buildServer, registerInternalAuth, assertJwtSecretConfigured } from '@hexdispatch/shared';
import { authRoutes } from './routes/auth';
import { rideRoutes } from './routes/rides';

export interface CoreApiOptions {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any;
  logLevel?: string;
}

export async function buildCoreApiApp(options: CoreApiOptions): Promise<FastifyInstance> {
  const { db, logLevel } = options;
  assertJwtSecretConfigured();

  const app = buildServer({
    service: 'core-api',
    logLevel,
    readinessChecks: {
      db: async () => {
        await db.execute('SELECT 1');
      },
    },
  });

  // Only the gateway and internal services may call core-api; x-user-* headers are trusted
  // solely because of this check.
  registerInternalAuth(app, { publicPrefixes: ['/docs'] });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(swagger, {
    openapi: {
      info: {
        title: 'HexDispatch Core API',
        description: 'Authentication, accounts, ride booking and trip state machine',
        version: '1.0.0',
      },
      servers: [
        { url: 'http://localhost:3000', description: 'API Gateway' },
        { url: 'http://localhost:3001', description: 'Direct Core API' },
      ],
      tags: [
        { name: 'Auth', description: 'User authentication & account management' },
        { name: 'Drivers', description: 'Driver status & profile' },
        { name: 'Rides', description: 'Rides and trip lifecycle' },
      ],
    },
    transform: jsonSchemaTransform,
  });

  await app.register(swaggerUi, {
    routePrefix: '/docs',
  });

  await app.register(authRoutes, { db });
  await app.register(rideRoutes, { db });

  return app;
}
