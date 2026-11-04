import { describe, it, expect, afterEach } from 'vitest';
import { Registry } from 'prom-client';
import { LocationBatchPublisher } from '../src/batch-publisher';
import type { DriverLocation } from '../src/driver-index';
import type { TypedMessage } from '@hexdispatch/shared';

describe('Location Ingest Backpressure & Overload Shedding (Phase 8 Task 4 & AC4)', () => {
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

  it('sheds excess load without crashing when queue exceeds maxQueueSize', async () => {
    const publishedBatches: TypedMessage[][] = [];
    const mockProducer = {
      publishBatch: async (messages: TypedMessage[]) => {
        publishedBatches.push(messages);
      },
    };

    const registry = new Registry();
    const maxQueueSize = 5;

    publisher = new LocationBatchPublisher(mockProducer, {
      batchSize: 100, // Do not auto-flush on small batch
      flushIntervalMs: 60000, // Do not auto-flush on timer
      maxQueueSize,
      registry,
    });

    // Enqueue 15 pings into a queue bounded at 5
    const promises: Promise<void>[] = [];
    for (let i = 0; i < 15; i++) {
      promises.push(publisher.enqueue(createPing(`driver-${i}`)));
    }

    // Flush remaining 5 items in the queue
    const flushed = await publisher.flush();
    expect(flushed).toBe(5);

    // Now all promises resolve cleanly
    await Promise.all(promises);

    const metricsStr = await registry.metrics();
    expect(metricsStr).toContain('location_dropped_total 10');
    expect(metricsStr).toContain('location_batch_size');

    expect(publishedBatches).toHaveLength(1);
    expect(publishedBatches[0]).toHaveLength(5);

    // Overload gauge resets to 0 after draining
    const drainedMetrics = await registry.metrics();
    expect(drainedMetrics).toContain('location_ingest_overloaded 0');
  });
});
