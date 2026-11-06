import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import {
  AppError,
  hashPassword,
  verifyPassword,
  signAccessToken,
  signRefreshToken,
  verifyToken,
  type UserRole,
} from '@hexdispatch/shared';
import { users, drivers, type User } from '../db/schema';

const signupSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
  // ADMIN accounts are never self-service; provision them out of band (seed/DB).
  role: z.enum(['RIDER', 'DRIVER']).default('RIDER'),
  vehicleType: z.string().min(1).optional(),
  plate: z.string().min(1).optional(),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const refreshSchema = z.object({
  refreshToken: z.string().min(1),
});

const driverStatusSchema = z.object({
  online: z.boolean(),
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle database instance
export const authRoutes: FastifyPluginAsync<{ db: any }> = async (app, { db }) => {
  // POST /auth/signup
  app.post(
    '/auth/signup',
    {
      schema: {
        summary: 'User signup',
        tags: ['Auth'],
        body: signupSchema,
        response: {
          201: z.object({
            user: z.object({
              id: z.string(),
              email: z.string(),
              role: z.string(),
            }),
            accessToken: z.string(),
            refreshToken: z.string(),
          }),
        },
      },
    },
    async (request, reply) => {
      const data = signupSchema.parse(request.body);

      const existing = await db
        .select()
        .from(users)
        .where(eq(users.email, data.email.toLowerCase()))
        .limit(1);

      if (existing.length > 0) {
        throw AppError.conflict('User with this email already exists');
      }

      if (data.role === 'DRIVER' && (!data.vehicleType || !data.plate)) {
        throw AppError.badRequest('Driver signup requires vehicleType and plate');
      }

      const passwordHash = await hashPassword(data.password);
      let newUser: User;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle transaction type
      await db.transaction(async (tx: any) => {
        const userRows = await tx
          .insert(users)
          .values({
            email: data.email.toLowerCase(),
            passwordHash,
            role: data.role,
          })
          .returning();
        newUser = userRows[0];

        if (data.role === 'DRIVER') {
          await tx.insert(drivers).values({
            userId: newUser.id,
            vehicleType: data.vehicleType!,
            plate: data.plate!,
            online: false,
          });
        }
      });

      const tokenPayload = {
        userId: newUser!.id,
        role: newUser!.role as UserRole,
        email: newUser!.email,
      };

      const [accessToken, refreshToken] = await Promise.all([
        signAccessToken(tokenPayload),
        signRefreshToken(tokenPayload),
      ]);

      return reply.code(201).send({
        user: {
          id: newUser!.id,
          email: newUser!.email,
          role: newUser!.role,
        },
        accessToken,
        refreshToken,
      });
    },
  );

  // POST /auth/login
  app.post(
    '/auth/login',
    {
      schema: {
        summary: 'User login',
        tags: ['Auth'],
        body: loginSchema,
        response: {
          200: z.object({
            user: z.object({
              id: z.string(),
              email: z.string(),
              role: z.string(),
            }),
            accessToken: z.string(),
            refreshToken: z.string(),
          }),
        },
      },
    },
    async (request, reply) => {
      const { email, password } = loginSchema.parse(request.body);

      const userRows = await db
        .select()
        .from(users)
        .where(eq(users.email, email.toLowerCase()))
        .limit(1);

      if (userRows.length === 0) {
        throw AppError.unauthorized('Invalid email or password');
      }

      const user = userRows[0];
      if (user.status !== 'ACTIVE') {
        throw AppError.unauthorized('User account is inactive');
      }

      const valid = await verifyPassword(password, user.passwordHash);
      if (!valid) {
        throw AppError.unauthorized('Invalid email or password');
      }

      const tokenPayload = {
        userId: user.id,
        role: user.role as UserRole,
        email: user.email,
      };

      const [accessToken, refreshToken] = await Promise.all([
        signAccessToken(tokenPayload),
        signRefreshToken(tokenPayload),
      ]);

      return reply.send({
        user: {
          id: user.id,
          email: user.email,
          role: user.role,
        },
        accessToken,
        refreshToken,
      });
    },
  );

  // POST /auth/refresh
  app.post(
    '/auth/refresh',
    {
      schema: {
        summary: 'Refresh access token',
        tags: ['Auth'],
        body: refreshSchema,
        response: {
          200: z.object({
            accessToken: z.string(),
            refreshToken: z.string(),
          }),
        },
      },
    },
    async (request, reply) => {
      const { refreshToken } = refreshSchema.parse(request.body);
      const verified = await verifyToken(refreshToken);

      const userRows = await db.select().from(users).where(eq(users.id, verified.userId)).limit(1);

      if (userRows.length === 0 || userRows[0].status !== 'ACTIVE') {
        throw AppError.unauthorized('User no longer exists or is inactive');
      }

      const user = userRows[0];
      const tokenPayload = {
        userId: user.id,
        role: user.role as UserRole,
        email: user.email,
      };

      const [newAccessToken, newRefreshToken] = await Promise.all([
        signAccessToken(tokenPayload),
        signRefreshToken(tokenPayload),
      ]);

      return reply.send({
        accessToken: newAccessToken,
        refreshToken: newRefreshToken,
      });
    },
  );

  // PATCH /drivers/me/status
  app.patch(
    '/drivers/me/status',
    {
      schema: {
        summary: 'Update driver online status',
        tags: ['Drivers'],
        body: driverStatusSchema,
      },
    },
    async (request, reply) => {
      const userId = (request.headers['x-user-id'] as string) || '';
      const userRole = (request.headers['x-user-role'] as string) || '';

      if (!userId || userRole !== 'DRIVER') {
        throw AppError.forbidden('Only drivers can update driver status');
      }

      const { online } = driverStatusSchema.parse(request.body);

      const updated = await db
        .update(drivers)
        .set({ online })
        .where(eq(drivers.userId, userId))
        .returning();

      if (updated.length === 0) {
        throw AppError.notFound('Driver profile not found');
      }

      return reply.send(updated[0]);
    },
  );

  // GET /drivers/me
  app.get(
    '/drivers/me',
    {
      schema: {
        summary: 'Get driver profile',
        tags: ['Drivers'],
      },
    },
    async (request, reply) => {
      const userId = (request.headers['x-user-id'] as string) || '';
      const userRole = (request.headers['x-user-role'] as string) || '';

      if (!userId || userRole !== 'DRIVER') {
        throw AppError.forbidden('Only drivers can view driver profile');
      }

      const driverRows = await db.select().from(drivers).where(eq(drivers.userId, userId)).limit(1);

      if (driverRows.length === 0) {
        throw AppError.notFound('Driver profile not found');
      }

      return reply.send(driverRows[0]);
    },
  );
};
