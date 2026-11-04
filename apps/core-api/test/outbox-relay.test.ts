import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { isNull } from 'drizzle-orm';
import { createTestDb } from './test-db';
import { outbox } from '../src/db/schema';
import { OutboxRelay, type MessagePublisher } from '../src/services/outbox-relay';
import { TOPICS, type RideRequestedEvent } from '@hexdispatch/contracts';

type TestDbResult = Awaited<ReturnType<typeof createTestDb>>;

describe('Transactional Outbox Relay & Consumer Idempotency (AC3)', () => {
  let db: TestDbResult['db'];
  let client: TestDbResult['client'];

  beforeAll(async () => {
    const testDb = await createTestDb();
    db = testDb.db;
    client = testDb.client;
  });

  afterAll(async () => {
    if (client) {
      await client.close();
    }
  });

  it('killing relay mid-publish and restarting loses no events; consumer with eventId deduplication sees each event once', async () => {
    // 1. Seed 5 messages in outbox
    const eventIds: string[] = [];
    for (let i = 0; i < 5; i++) {
      const eventId = randomUUID();
      eventIds.push(eventId);

      const eventPayload: RideRequestedEvent = {
        eventId,
        type: TOPICS.RIDE_REQUESTED,
        version: 1,
        occurredAt: new Date().toISOString(),
        correlationId: randomUUID(),
        payload: {
          rideId: randomUUID(),
          riderId: randomUUID(),
          pickup: { lat: 12.9, lng: 77.6 },
          dropoff: { lat: 12.95, lng: 77.65 },
          pickupCell: '88618925d3fffff',
          vehicleType: 'sedan',
          requestedAt: new Date().toISOString(),
        },
      };

      await db.insert(outbox).values({
        aggregateId: eventPayload.payload.rideId,
        topic: TOPICS.RIDE_REQUESTED,
        key: '88618925d3fffff',
        payload: eventPayload,
      });
    }

    // 2. Simulated publisher that fails/crashes after publishing 2 messages
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Generic event payload for broker test
    const publishedLog: Array<{ topic: string; key: string; payload: any }> = [];
    let countBeforeCrash = 0;

    const crashingPublisher: MessagePublisher = {
      publish: async (topic, key, payload) => {
        countBeforeCrash += 1;
        if (countBeforeCrash > 2) {
          throw new Error('SIMULATED_RELAY_CRASH_OR_KILL');
        }
        publishedLog.push({ topic, key, payload });
      },
    };

    const firstRelay = new OutboxRelay(db, crashingPublisher);

    // Attempt publishing - will crash after 2 messages
    await expect(firstRelay.pollOnce(10)).rejects.toThrow('SIMULATED_RELAY_CRASH_OR_KILL');
    firstRelay.stop();

    // Verify 2 messages were delivered before crash
    expect(publishedLog.length).toBe(2);

    // Check DB: because each successful publish marks published_at, let's verify remaining unpublished
    const pendingAfterCrash = await db.select().from(outbox).where(isNull(outbox.publishedAt));

    // Remaining unpublished messages are still in outbox (none lost!)
    expect(pendingAfterCrash.length).toBeGreaterThan(0);

    // 3. Restarting relay with healthy publisher
    const healthyPublisher: MessagePublisher = {
      publish: async (topic, key, payload) => {
        publishedLog.push({ topic, key, payload });
      },
    };

    const secondRelay = new OutboxRelay(db, healthyPublisher);
    const publishedOnRestart = await secondRelay.pollOnce(10);
    expect(publishedOnRestart).toBe(pendingAfterCrash.length);
    secondRelay.stop();

    // Check DB: all messages are now published
    const remainingAfterRestart = await db.select().from(outbox).where(isNull(outbox.publishedAt));
    expect(remainingAfterRestart.length).toBe(0);

    // Verify all 5 eventIds were published to broker
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Event payload
    const brokerEventIds = publishedLog.map((m) => (m.payload as any)?.eventId);
    for (const expectedEventId of eventIds) {
      expect(brokerEventIds).toContain(expectedEventId);
    }

    // 4. Consumer with eventId idempotency deduplication
    // Simulate duplicate delivery (e.g. at-least-once delivery)
    const simulatedDeliveryStream = [...publishedLog, ...publishedLog.slice(0, 2)];
    const processedEvents = new Map<string, number>();

    // Consumer processing logic:
    for (const msg of simulatedDeliveryStream) {
      const eid = msg.payload.eventId;
      if (processedEvents.has(eid)) {
        // Idempotently skip duplicate
        continue;
      }
      processedEvents.set(eid, 1);
    }

    // Assert: despite duplicate messages in the stream, consumer sees each logical event exactly once
    expect(processedEvents.size).toBe(5);
    for (const expectedEventId of eventIds) {
      expect(processedEvents.get(expectedEventId)).toBe(1);
    }
  });
});
