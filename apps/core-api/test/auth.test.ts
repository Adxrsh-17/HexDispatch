import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDb } from './test-db';
import { buildCoreApiApp } from '../src/app';
import type { FastifyInstance } from 'fastify';

type TestDbResult = Awaited<ReturnType<typeof createTestDb>>;

describe('Auth & Driver Routes', () => {
  let db: TestDbResult['db'];
  let client: TestDbResult['client'];
  let app: FastifyInstance;

  beforeAll(async () => {
    const testDb = await createTestDb();
    db = testDb.db;
    client = testDb.client;

    app = await buildCoreApiApp({ db, logLevel: 'silent' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    if (client) {
      await client.close();
    }
  });

  it('signs up a new rider and returns JWT tokens', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/signup',
      payload: {
        email: 'rider1@example.com',
        password: 'securePassword123',
        role: 'RIDER',
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.user.email).toBe('rider1@example.com');
    expect(body.user.role).toBe('RIDER');
    expect(body.accessToken).toBeDefined();
    expect(body.refreshToken).toBeDefined();
  });

  it('rejects signup with duplicate email', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/signup',
      payload: {
        email: 'rider1@example.com',
        password: 'anotherPassword',
        role: 'RIDER',
      },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('CONFLICT');
  });

  it('signs up a driver with vehicle and plate', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/signup',
      payload: {
        email: 'driver1@example.com',
        password: 'driverPassword123',
        role: 'DRIVER',
        vehicleType: 'sedan',
        plate: 'KA-01-AB-1234',
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.user.role).toBe('DRIVER');
  });

  it('rejects driver signup without vehicle details', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/signup',
      payload: {
        email: 'invalid-driver@example.com',
        password: 'driverPassword123',
        role: 'DRIVER',
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain('vehicleType');
  });

  it('logs in successfully with correct credentials', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: {
        email: 'rider1@example.com',
        password: 'securePassword123',
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.accessToken).toBeDefined();
    expect(body.refreshToken).toBeDefined();
  });

  it('rejects login with invalid password', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: {
        email: 'rider1@example.com',
        password: 'wrongPassword',
      },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('UNAUTHORIZED');
  });

  it('refreshes token with valid refresh token', async () => {
    // Login to get refresh token
    const loginRes = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: {
        email: 'rider1@example.com',
        password: 'securePassword123',
      },
    });
    const { refreshToken } = loginRes.json();

    const refreshRes = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      payload: { refreshToken },
    });

    expect(refreshRes.statusCode).toBe(200);
    const body = refreshRes.json();
    expect(body.accessToken).toBeDefined();
    expect(body.refreshToken).toBeDefined();
  });

  it('updates driver online status and retrieves profile', async () => {
    // Signup driver
    const signupRes = await app.inject({
      method: 'POST',
      url: '/auth/signup',
      payload: {
        email: 'online-driver@example.com',
        password: 'password123',
        role: 'DRIVER',
        vehicleType: 'suv',
        plate: 'MH-02-XY-9876',
      },
    });
    const driverId = signupRes.json().user.id;

    // PATCH /drivers/me/status
    const patchRes = await app.inject({
      method: 'PATCH',
      url: '/drivers/me/status',
      headers: {
        'x-user-id': driverId,
        'x-user-role': 'DRIVER',
      },
      payload: { online: true },
    });

    expect(patchRes.statusCode).toBe(200);
    expect(patchRes.json().online).toBe(true);

    // GET /drivers/me
    const getRes = await app.inject({
      method: 'GET',
      url: '/drivers/me',
      headers: {
        'x-user-id': driverId,
        'x-user-role': 'DRIVER',
      },
    });

    expect(getRes.statusCode).toBe(200);
    const profile = getRes.json();
    expect(profile.online).toBe(true);
    expect(profile.vehicleType).toBe('suv');
    expect(profile.plate).toBe('MH-02-XY-9876');
  });
});
