import { randomUUID } from 'node:crypto';
import { TOPICS, type LocationUpdatedEvent } from '@hexdispatch/contracts';
import type { KafkaProducer } from '@hexdispatch/shared';
import { Counter, Histogram, register, type Registry } from 'prom-client';
import type { DriverLocation } from './driver-index';

export interface BatchPublisherOptions {
  batchSize?: number;
  flushIntervalMs?: number;
  registry?: Registry;
}

export interface LocationMetrics {
  pingsTotal: Counter<string>;
  batchSizeHistogram: Histogram<string>;
  ingestDuration: Histogram<string>;
}

export function createLocationMetrics(registry?: Registry): LocationMetrics {
  const targetReg = registry ?? register;

  const pingsTotal =
    (targetReg.getSingleMetric('location_pings_total') as Counter<string>) ??
    new Counter({
      name: 'location_pings_total',
      help: 'Total number of location pings received',
      labelNames: ['status'] as const,
      registers: [targetReg],
    });

  const batchSizeHistogram =
    (targetReg.getSingleMetric('location_batch_size') as Histogram<string>) ??
    new Histogram({
      name: 'location_batch_size',
      help: 'Distribution of batch sizes published to Kafka',
      buckets: [1, 5, 10, 25, 50, 100, 200],
      registers: [targetReg],
    });

  const ingestDuration =
    (targetReg.getSingleMetric('location_ingest_duration_seconds') as Histogram<string>) ??
    new Histogram({
      name: 'location_ingest_duration_seconds',
      help: 'Duration of location ping ingest processing in seconds',
      buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25],
      registers: [targetReg],
    });

  return { pingsTotal, batchSizeHistogram, ingestDuration };
}

export class LocationBatchPublisher {
  private queue: Array<{
    loc: DriverLocation;
    correlationId: string;
    resolve: () => void;
    reject: (err: unknown) => void;
  }> = [];

  private timer: NodeJS.Timeout | null = null;
  private batchSize: number;
  private flushIntervalMs: number;
  private metrics: LocationMetrics;

  constructor(
    private producer: { publishBatch: KafkaProducer['publishBatch'] },
    options: BatchPublisherOptions = {},
  ) {
    this.batchSize = options.batchSize ?? 50;
    this.flushIntervalMs = options.flushIntervalMs ?? 200;
    this.metrics = createLocationMetrics(options.registry);
    this.startTimer();
  }

  private startTimer(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.flush();
    }, this.flushIntervalMs);
  }

  async enqueue(loc: DriverLocation, correlationId: string = randomUUID()): Promise<void> {
    return new Promise((resolve, reject) => {
      this.queue.push({ loc, correlationId, resolve, reject });
      this.metrics.pingsTotal.labels(loc.status).inc();

      if (this.queue.length >= this.batchSize) {
        void this.flush();
      }
    });
  }

  async flush(): Promise<number> {
    if (this.queue.length === 0) return 0;

    const currentBatch = this.queue.splice(0, this.batchSize);
    const count = currentBatch.length;
    this.metrics.batchSizeHistogram.observe(count);

    const messages = currentBatch.map(({ loc, correlationId }) => {
      const event: LocationUpdatedEvent = {
        eventId: randomUUID(),
        type: TOPICS.LOCATION_UPDATED,
        version: 1,
        occurredAt: loc.ts,
        correlationId,
        payload: {
          driverId: loc.driverId as `${string}-${string}-${string}-${string}-${string}`,
          lat: loc.lat,
          lng: loc.lng,
          heading: loc.heading,
          speedMps: loc.speedMps,
          status: loc.status,
          ts: loc.ts,
        },
      };

      return {
        topic: TOPICS.LOCATION_UPDATED,
        key: loc.driverId, // Partition key: driverId
        payload: event,
      };
    });

    try {
      await this.producer.publishBatch(messages);
      for (const item of currentBatch) {
        item.resolve();
      }
    } catch (err) {
      for (const item of currentBatch) {
        item.reject(err);
      }
    }

    return count;
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
