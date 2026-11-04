import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { LocationBatchPublisher } from '../src/batch-publisher';
import type { DriverLocation } from '../src/driver-index';
import { TOPICS, locationUpdatedEvent } from '@hexdispatch/contracts';
import { Registry } from 'prom-client';
import type { TypedMessage } from '@hexdispatch/shared';

describe('Location Batch Publisher (AC4)', () => {
  let publisher: LocationBatchPublisher | null = null;

  afterEach(() => {
    if (publisher) {
      publisher.stop();
      publisher = null;
    }
  });

  function createPing(driverId: string): DriverLocation {
    return {
      driverId,
      lat: 12.9716,
      lng: 77.5946,
      heading: 90,
      speedMps: 15,
      status: 'AVAILABLE',
      ts: new Date().toISOString(),
    };
  }

  it('flushes immediately when batchSize is reached', async () => {
    const publishedBatches: TypedMessage[][] = [];
    const mockProducer = {
      publishBatch: async (messages: TypedMessage[]) => {
        publishedBatches.push(messages);
      },
    };

    publisher = new LocationBatchPublisher(mockProducer, {
      batchSize: 3,
      flushIntervalMs: 5000, // Large interval to verify size triggers it
    });

    const p1 = publisher.enqueue(createPing('d1'));
    const p2 = publisher.enqueue(createPing('d2'));
    expect(publishedBatches).toHaveLength(0);

    const p3 = publisher.enqueue(createPing('d3'));
    await Promise.all([p1, p2, p3]);

    expect(publishedBatches).toHaveLength(1);
    expect(publishedBatches[0]).toHaveLength(3);
  });

  it('flushes on interval when batch is under size limit', async () => {
    const publishedBatches: TypedMessage[][] = [];
    const mockProducer = {
      publishBatch: async (messages: TypedMessage[]) => {
        publishedBatches.push(messages);
      },
    };

    publisher = new LocationBatchPublisher(mockProducer, {
      batchSize: 10,
      flushIntervalMs: 50,
    });

    const p1 = publisher.enqueue(createPing('d1'));
    const p2 = publisher.enqueue(createPing('d2'));

    await Promise.all([p1, p2]);

    expect(publishedBatches).toHaveLength(1);
    expect(publishedBatches[0]).toHaveLength(2);
  });

  it('enforces Kafka message key as driverId and schema-valid payload', async () => {
    const publishedBatches: TypedMessage[][] = [];
    const mockProducer = {
      publishBatch: async (messages: TypedMessage[]) => {
        publishedBatches.push(messages);
      },
    };

    const registry = new Registry();
    publisher = new LocationBatchPublisher(mockProducer, {
      batchSize: 2,
      flushIntervalMs: 5000,
      registry,
    });

    const driverA = randomUUID();
    const driverB = randomUUID();

    await Promise.all([
      publisher.enqueue(createPing(driverA)),
      publisher.enqueue(createPing(driverB)),
    ]);

    expect(publishedBatches).toHaveLength(1);
    const batch = publishedBatches[0]!;

    expect(batch[0]!.topic).toBe(TOPICS.LOCATION_UPDATED);
    expect(batch[0]!.key).toBe(driverA);
    const parsedPayloadA = locationUpdatedEvent.safeParse(batch[0]!.payload);
    expect(parsedPayloadA.success).toBe(true);

    expect(batch[1]!.topic).toBe(TOPICS.LOCATION_UPDATED);
    expect(batch[1]!.key).toBe(driverB);
    const parsedPayloadB = locationUpdatedEvent.safeParse(batch[1]!.payload);
    expect(parsedPayloadB.success).toBe(true);

    // Verify metrics observed
    const metricsStr = await registry.metrics();
    expect(metricsStr).toContain('location_pings_total');
    expect(metricsStr).toContain('location_batch_size');
  });
});
