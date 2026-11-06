import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { withInternalAuth } from '@hexdispatch/shared';
import { randomUUID } from 'node:crypto';
import Redis from 'ioredis-mock';
import WebSocket from 'ws';
import { buildGatewayApp } from '../src/app';
import { signAccessToken } from '@hexdispatch/shared';
import type { FastifyInstance } from 'fastify';

describe('Gateway Realtime & Multi-Node Fanout (AC3)', () => {
  let node1App: FastifyInstance;
  let node2App: FastifyInstance;
  let node1Port: number;
  let node2Port: number;
  let sharedRedisPub1: InstanceType<typeof Redis>;
  let sharedRedisSub1: InstanceType<typeof Redis>;
  let sharedRedisPub2: InstanceType<typeof Redis>;
  let sharedRedisSub2: InstanceType<typeof Redis>;
  let riderToken: string;

  beforeAll(async () => {
    riderToken = await signAccessToken({
      userId: 'rider-test-1',
      role: 'RIDER',
      email: 'rider@example.com',
    });

    sharedRedisPub1 = new Redis();
    sharedRedisSub1 = new Redis();
    sharedRedisPub2 = new Redis();
    sharedRedisSub2 = new Redis();

    node1App = withInternalAuth(
      await buildGatewayApp({
        redisClient: sharedRedisPub1,
        redisSubClient: sharedRedisSub1,
        logLevel: 'silent',
        allowDemoWsToken: true,
      }),
    );
    const addr1 = await node1App.listen({ host: '127.0.0.1', port: 0 });
    node1Port = Number(new URL(addr1).port);

    node2App = withInternalAuth(
      await buildGatewayApp({
        redisClient: sharedRedisPub2,
        redisSubClient: sharedRedisSub2,
        logLevel: 'silent',
        allowDemoWsToken: true,
      }),
    );
    const addr2 = await node2App.listen({ host: '127.0.0.1', port: 0 });
    node2Port = Number(new URL(addr2).port);
  });

  afterAll(async () => {
    await node1App.close();
    await node2App.close();
  });

  function connectWs(port: number, token: string): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`);
      ws.on('open', () => resolve(ws));
      ws.on('error', reject);
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Generic WebSocket message payload for tests
  function waitForMessage(ws: WebSocket, predicate?: (msg: any) => boolean): Promise<any> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timeout waiting for ws message')), 10000);
      const handler = (data: Buffer | string) => {
        try {
          const parsed = JSON.parse(data.toString());
          if (!predicate || predicate(parsed)) {
            clearTimeout(timer);
            ws.off('message', handler);
            resolve(parsed);
          }
        } catch {
          // ignore malformed
        }
      };
      ws.on('message', handler);
    });
  }

  it('rejects unauthenticated connections', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${node1Port}/ws?token=invalid.jwt.token`);
    const closePromise = new Promise<{ code: number; reason: string }>((resolve) => {
      ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() }));
    });
    const result = await closePromise;
    expect(result.code).toBe(4001);
  });

  it('handles heartbeat ping/pong', async () => {
    const ws = await connectWs(node1Port, riderToken);
    try {
      const pongPromise = waitForMessage(ws, (m) => m.type === 'pong');
      ws.send(JSON.stringify({ type: 'ping' }));
      const pong = await pongPromise;
      expect(pong.type).toBe('pong');
      expect(pong.ts).toBeDefined();
    } finally {
      ws.close();
    }
  });

  it('multi-node fanout: event published on Node 1 reaches rider connected to Node 2', async () => {
    const room = `ride:multi-node-${randomUUID()}`;
    const clientOnNode1 = await connectWs(node1Port, riderToken);
    const clientOnNode2 = await connectWs(node2Port, riderToken);

    try {
      // Both subscribe to the same room
      const ack1Promise = waitForMessage(clientOnNode1, (m) => m.subscribed === room);
      clientOnNode1.send(JSON.stringify({ type: 'subscribe', room }));
      await ack1Promise;

      const ack2Promise = waitForMessage(clientOnNode2, (m) => m.subscribed === room);
      clientOnNode2.send(JSON.stringify({ type: 'subscribe', room }));
      await ack2Promise;

      // Small delay to ensure subscription propagation
      await new Promise((r) => setTimeout(r, 100));

      // Broadcast an event via Node 1's HTTP broadcast endpoint
      const updatePromiseNode1 = waitForMessage(clientOnNode1, (m) => m.type === 'DRIVER_LOCATION');
      const updatePromiseNode2 = waitForMessage(clientOnNode2, (m) => m.type === 'DRIVER_LOCATION');

      const broadcastRes = await node1App.inject({
        method: 'POST',
        url: '/events/broadcast',
        payload: {
          room,
          type: 'DRIVER_LOCATION',
          data: { lat: 12.9716, lng: 77.5946, speed: 35.5 },
        },
      });
      expect(broadcastRes.statusCode).toBe(200);

      const [msgNode1, msgNode2] = await Promise.all([updatePromiseNode1, updatePromiseNode2]);

      expect(msgNode1.type).toBe('DRIVER_LOCATION');
      expect(msgNode1.data.lat).toBe(12.9716);

      // Verify Node 2 client received it via Redis pub/sub
      expect(msgNode2.type).toBe('DRIVER_LOCATION');
      expect(msgNode2.data.lat).toBe(12.9716);
      expect(msgNode2.eventId).toBe(msgNode1.eventId);
    } finally {
      clientOnNode1.close();
      clientOnNode2.close();
    }
  });

  it('reconnects with lastEventId to replay missed events without gaps or duplicates', async () => {
    const room = `ride:replay-${randomUUID()}`;
    const client1 = await connectWs(node1Port, riderToken);

    let firstEventId = '';
    try {
      const ackPromise = waitForMessage(client1, (m) => m.subscribed === room);
      client1.send(JSON.stringify({ type: 'subscribe', room }));
      await ackPromise;

      // Publish event 1
      const evt1Promise = waitForMessage(client1, (m) => m.type === 'STEP_1');
      await node1App.inject({
        method: 'POST',
        url: '/events/broadcast',
        payload: { room, type: 'STEP_1', data: { step: 1 } },
      });
      const evt1 = await evt1Promise;
      firstEventId = evt1.eventId;
      expect(firstEventId).toBeDefined();
    } finally {
      // Rider disconnects
      client1.close();
    }

    // While disconnected, broadcast event 2 and event 3
    await node1App.inject({
      method: 'POST',
      url: '/events/broadcast',
      payload: { room, type: 'STEP_2', data: { step: 2 } },
    });
    await node1App.inject({
      method: 'POST',
      url: '/events/broadcast',
      payload: { room, type: 'STEP_3', data: { step: 3 } },
    });

    // Reconnect on Node 2 with lastEventId = firstEventId
    const client2 = await connectWs(node2Port, riderToken);
    const replayedEvents: Array<{ type: string; data: { step: number } }> = [];

    client2.on('message', (data) => {
      try {
        const parsed = JSON.parse(data.toString());
        if (parsed.type && parsed.type.startsWith('STEP_')) {
          replayedEvents.push(parsed);
        }
      } catch {
        // ignore
      }
    });

    client2.send(JSON.stringify({ type: 'subscribe', room, lastEventId: firstEventId }));

    // Wait until STEP_2 and STEP_3 have both arrived
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timed out waiting for replay')), 3000);
      const check = setInterval(() => {
        if (replayedEvents.length >= 2) {
          clearInterval(check);
          clearTimeout(timeout);
          resolve();
        }
      }, 50);
    });

    client2.close();

    expect(replayedEvents).toHaveLength(2);
    expect(replayedEvents[0]!.type).toBe('STEP_2');
    expect(replayedEvents[0]!.data.step).toBe(2);
    expect(replayedEvents[1]!.type).toBe('STEP_3');
    expect(replayedEvents[1]!.data.step).toBe(3);
    // Crucially: event 1 was NOT replayed (no duplicate)
    expect(replayedEvents.find((e) => e.type === 'STEP_1')).toBeUndefined();
  });
});
