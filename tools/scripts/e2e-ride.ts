import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import Redis from 'ioredis-mock';
type RedisClient = InstanceType<typeof Redis>;
import { buildCoreApiApp } from '../../apps/core-api/src/app';
import { buildLocationApp } from '../../apps/location/src/app';
import { DriverIndex } from '../../apps/location/src/driver-index';
import { NearbySearch } from '../../apps/location/src/nearby';
import { LocationBatchPublisher } from '../../apps/location/src/batch-publisher';
import { buildDispatchApp } from '../../apps/dispatch/src/app';
import { DriverClaimService } from '../../apps/dispatch/src/services/driver-claim';
import { MatchingRegistry } from '../../apps/dispatch/src/services/matching-registry';
import { OfferManager } from '../../apps/dispatch/src/services/offer-manager';
import { DispatchEngine } from '../../apps/dispatch/src/services/dispatch-engine';
import { buildGatewayApp } from '../../apps/gateway/src/app';
import { RealtimeGateway } from '../../apps/gateway/src/ws/gateway-ws';
import { createTestDb as createCoreTestDb } from '../../apps/core-api/test/test-db';
import { createTestDb as createDispatchTestDb } from '../../apps/dispatch/test/test-db';
import { TOPICS, type RideRequestedEvent } from '../../packages/contracts/src';

export interface E2ETestEnvironment {
  gatewayUrl: string;
  close: () => Promise<void>;
}

export async function setupE2EEnvironment(): Promise<E2ETestEnvironment> {
  const sharedRedisPub = new Redis();
  const sharedRedisSub = new Redis();

  // 1. Core API setup
  const coreDb = await createCoreTestDb();
  const coreApp = await buildCoreApiApp({ db: coreDb.db, logLevel: 'silent' });

  // eslint-disable-next-line prefer-const -- Forward reference in hook
  let dispatchEngine: DispatchEngine;

  // Connect Core API outbox/events -> Dispatch
  // (In real deployment this happens via Kafka; here we wire direct event forwarding)
  coreApp.addHook('onSend', async (req, reply, payload) => {
    if (req.method === 'POST' && req.url === '/rides' && reply.statusCode === 201) {
      try {
        const payloadStr = typeof payload === 'string' ? payload : (payload as Buffer).toString();
        const ride = JSON.parse(payloadStr);
        const pickup = ride.pickup ?? { lat: ride.pickupLat, lng: ride.pickupLng };
        const dropoff = ride.dropoff ?? { lat: ride.dropoffLat, lng: ride.dropoffLng };
        const event: RideRequestedEvent = {
          eventId: randomUUID(),
          type: TOPICS.RIDE_REQUESTED,
          version: 1,
          occurredAt: new Date().toISOString(),
          correlationId: randomUUID(),
          payload: {
            rideId: ride.id,
            riderId: ride.riderId,
            pickup,
            dropoff,
            pickupCell: ride.pickupCell,
            vehicleType: ride.vehicleType,
            requestedAt: ride.createdAt,
          },
        };
        if (dispatchEngine) {
          setImmediate(() => {
            void dispatchEngine.handleRideRequested(event);
          });
        }
      } catch (err) {
        console.error('Failed to trigger ride requested hook:', err);
      }
    }
    return payload;
  });

  const coreAddr = await coreApp.listen({ host: '127.0.0.1', port: 0 });

  const redisPubClient = sharedRedisPub as unknown as RedisClient;
  const redisSubClient = sharedRedisSub as unknown as RedisClient;

  // 2. Location service setup
  const driverIndex = new DriverIndex(redisPubClient, 60);
  const nearbySearch = new NearbySearch(driverIndex);
  const locationBatchPublisher = new LocationBatchPublisher(
    { publishBatch: async () => {} },
    { batchSize: 50, flushIntervalMs: 500 },
  );
  const locationApp = await buildLocationApp({
    driverIndex,
    nearbySearch,
    batchPublisher: locationBatchPublisher,
    redisPubSub: redisPubClient,
    logLevel: 'silent',
  });
  const locAddr = await locationApp.listen({ host: '127.0.0.1', port: 0 });

  // 3. Dispatch service setup
  const dispatchDb = await createDispatchTestDb();
  const claimService = new DriverClaimService(redisPubClient);
  const matchingRegistry = new MatchingRegistry();

  const offerManager = new OfferManager({
    db: dispatchDb.db,
    redis: redisPubClient,
    claimService,
    coreApiUrl: coreAddr,
    redisPubSub: redisPubClient,
    defaultOfferTimeoutSec: 15,
    onReofferNeeded: async (rideId, excl) => {
      if (dispatchEngine) await dispatchEngine.handleReofferNeeded(rideId, excl);
    },
  });

  dispatchEngine = new DispatchEngine({
    db: dispatchDb.db,
    offerManager,
    matchingRegistry,
    claimService,
    coreApiUrl: coreAddr,
    locationUrl: locAddr,
    redisPubSub: redisPubClient,
    matchingPolicy: 'greedy',
    maxOfferAttempts: 3,
  });

  const dispatchApp = await buildDispatchApp({
    offerManager,
    dispatchEngine,
    logLevel: 'silent',
  });
  const dispatchAddr = await dispatchApp.listen({ host: '127.0.0.1', port: 0 });

  // 4. Gateway setup
  const realtimeGateway = new RealtimeGateway(redisPubClient, redisSubClient);
  const gatewayApp = await buildGatewayApp({
    coreApiUrl: coreAddr,
    dispatchUrl: dispatchAddr,
    locationUrl: locAddr,
    redisClient: redisPubClient,
    redisSubClient: redisSubClient,
    realtimeGateway,
    logLevel: 'silent',
  });
  const gatewayAddr = await gatewayApp.listen({ host: '127.0.0.1', port: 0 });

  return {
    gatewayUrl: gatewayAddr,
    close: async () => {
      offerManager.stop();
      locationBatchPublisher.stop();
      await gatewayApp.close();
      await dispatchApp.close();
      await locationApp.close();
      await coreApp.close();
      await coreDb.clean();
      await dispatchDb.clean();
    },
  };
}

function connectWs(gatewayUrl: string, token: string): Promise<WebSocket> {
  const wsUrl = `${gatewayUrl.replace('http://', 'ws://')}/ws?token=${token}`;
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

interface WsMessage {
  type: string;
  data?: Record<string, unknown>;
  [key: string]: unknown;
}

function waitForEvent(
  ws: WebSocket,
  predicate: (msg: WsMessage) => boolean,
  timeoutMs = 5000,
): Promise<WsMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timeout waiting for event')), timeoutMs);
    const handler = (data: WebSocket.RawData) => {
      try {
        const parsed = JSON.parse(data.toString()) as WsMessage;
        if (predicate(parsed)) {
          clearTimeout(timer);
          ws.off('message', handler);
          resolve(parsed);
        }
      } catch {
        // ignore
      }
    };
    ws.on('message', handler);
  });
}

export async function runE2ERide(gatewayUrl: string): Promise<void> {
  console.log('--- Starting End-to-End Ride Lifecycle (AC1) ---');

  // 0. Register Rider & Driver via Auth API
  console.log('0. Registering rider and driver accounts...');
  const riderSignupRes = await fetch(`${gatewayUrl}/auth/signup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: `rider.${randomUUID()}@example.com`,
      password: 'password123',
      role: 'RIDER',
    }),
  });
  if (!riderSignupRes.ok) {
    throw new Error(`Rider signup failed: ${riderSignupRes.status} ${await riderSignupRes.text()}`);
  }
  const riderAuth = (await riderSignupRes.json()) as { accessToken: string; user: { id: string } };
  const riderToken = riderAuth.accessToken;

  const driverSignupRes = await fetch(`${gatewayUrl}/auth/signup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: `driver.${randomUUID()}@example.com`,
      password: 'password123',
      role: 'DRIVER',
      vehicleType: 'sedan',
      plate: 'KA-01-AB-1234',
    }),
  });
  if (!driverSignupRes.ok) {
    throw new Error(
      `Driver signup failed: ${driverSignupRes.status} ${await driverSignupRes.text()}`,
    );
  }
  const driverAuth = (await driverSignupRes.json()) as {
    accessToken: string;
    user: { id: string };
  };
  const driverId = driverAuth.user.id;
  const driverToken = driverAuth.accessToken;

  const statusRes = await fetch(`${gatewayUrl}/drivers/me/status`, {
    method: 'PATCH',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${driverToken}`,
    },
    body: JSON.stringify({ online: true }),
  });
  if (!statusRes.ok) {
    throw new Error(`Driver status update failed: ${statusRes.status}`);
  }

  let driverWs: WebSocket | undefined;
  let riderWs: WebSocket | undefined;

  try {
    // 1. Driver goes online and sends location ping
    console.log(
      '1. Driver setting status online and publishing location ping near Bangalore center...',
    );
    const pingRes = await fetch(`${gatewayUrl}/drivers/me/location`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${driverToken}`,
      },
      body: JSON.stringify({
        lat: 12.9716,
        lng: 77.5946,
        heading: 90,
        speedMps: 10,
        status: 'AVAILABLE',
        ts: new Date().toISOString(),
      }),
    });
    if (!pingRes.ok) throw new Error(`Driver location ping failed: ${pingRes.status}`);

    // 2. Driver connects to Gateway WebSocket and subscribes to driver room
    console.log('2. Driver connecting to Gateway WebSocket...');
    driverWs = await connectWs(gatewayUrl, driverToken);
    driverWs.send(JSON.stringify({ type: 'subscribe', room: `driver:${driverId}` }));

    // 3. Rider connects to Gateway WebSocket
    console.log('3. Rider connecting to Gateway WebSocket...');
    riderWs = await connectWs(gatewayUrl, riderToken);

    // 4. Rider requests a ride
    console.log('4. Rider creating ride request: Bangalore City Center -> Indiranagar...');
    const offerReceivedPromise = waitForEvent(driverWs, (m) => m.type === 'OFFER_SENT');

    const createRideRes = await fetch(`${gatewayUrl}/rides`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${riderToken}`,
      },
      body: JSON.stringify({
        pickup: { lat: 12.9716, lng: 77.5946 },
        dropoff: { lat: 12.9784, lng: 77.6408 },
        vehicleType: 'sedan',
      }),
    });
    if (!createRideRes.ok) {
      throw new Error(`Create ride failed: ${createRideRes.status} ${await createRideRes.text()}`);
    }
    const ride = (await createRideRes.json()) as { id: string; status: string };
    console.log(`   Ride created with ID: ${ride.id}, status: ${ride.status}`);

    // Rider subscribes to ride room
    riderWs.send(JSON.stringify({ type: 'subscribe', room: `ride:${ride.id}` }));

    // 5. Driver receives OFFER_SENT
    console.log('5. Waiting for dispatch matching and OFFER_SENT over WebSocket to driver...');
    const offerEvent = await offerReceivedPromise;
    const offerId = (offerEvent.data?.offerId ?? '') as string;
    console.log(`   Offer received by driver! OfferId: ${offerId}`);

    // 6. Driver accepts offer
    console.log('6. Driver accepting offer...');
    const riderMatchedPromise = waitForEvent(riderWs, (m) => m.type === 'RIDE_MATCHED');
    const acceptRes = await fetch(`${gatewayUrl}/offers/${offerId}/accept`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${driverToken}`,
      },
      body: JSON.stringify({ driverId }),
    });
    if (!acceptRes.ok) throw new Error(`Accept offer failed: ${acceptRes.status}`);

    // 7. Rider receives RIDE_MATCHED / ASSIGNED
    console.log('7. Waiting for RIDE_MATCHED event on rider WebSocket...');
    const matchedEvent = await riderMatchedPromise;
    console.log(`   Rider received match! Driver assigned: ${matchedEvent.data?.driverId}`);

    // 8. Driver arrives at pickup
    console.log('8. Driver arrives at pickup...');
    const driverArrivedPromise = waitForEvent(riderWs, (m) => m.type === 'DRIVER_ARRIVED');
    const arrivedRes = await fetch(`${gatewayUrl}/rides/${ride.id}/arrived`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${driverToken}`,
      },
      body: JSON.stringify({ driverId }),
    });
    if (!arrivedRes.ok) throw new Error(`Driver arrived failed: ${arrivedRes.status}`);
    await driverArrivedPromise;
    console.log('   Rider received DRIVER_ARRIVED notification.');

    // 9. Driver starts trip
    console.log('9. Driver starting trip...');
    const inTripPromise = waitForEvent(riderWs, (m) => m.type === 'IN_TRIP');
    const startRes = await fetch(`${gatewayUrl}/rides/${ride.id}/start`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${driverToken}`,
      },
      body: JSON.stringify({ driverId }),
    });
    if (!startRes.ok) throw new Error(`Start trip failed: ${startRes.status}`);
    await inTripPromise;
    console.log('   Rider received IN_TRIP notification.');

    // 10. Driver completes trip
    console.log('10. Driver completing trip at destination...');
    const completedPromise = waitForEvent(riderWs, (m) => m.type === 'COMPLETED');
    const completeRes = await fetch(`${gatewayUrl}/rides/${ride.id}/complete`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${driverToken}`,
      },
      body: JSON.stringify({ driverId }),
    });
    if (!completeRes.ok) throw new Error(`Complete trip failed: ${completeRes.status}`);
    await completedPromise;
    console.log('   Rider received COMPLETED notification.');

    console.log('--- End-to-End Ride Lifecycle Successfully Verified! ---');
  } finally {
    if (driverWs) driverWs.close();
    if (riderWs) riderWs.close();
  }
}

// If run directly from CLI
if (process.argv[1]?.includes('e2e-ride')) {
  (async () => {
    const env = await setupE2EEnvironment();
    try {
      await runE2ERide(env.gatewayUrl);
      process.exit(0);
    } catch (err) {
      console.error('E2E ride execution error:', err);
      process.exit(1);
    } finally {
      await env.close();
    }
  })();
}
