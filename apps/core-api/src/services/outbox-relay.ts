import { eq, isNull, sql } from 'drizzle-orm';
import { Counter, Gauge, type Registry } from 'prom-client';
import { outbox, type OutboxMessage } from '../db/schema';
import { createLogger } from '@hexdispatch/shared';

const logger = createLogger({ service: 'outbox-relay' });

export interface MessagePublisher {
  publish: (topic: string, key: string, payload: unknown) => Promise<void>;
}

let outboxPending: Gauge<string> | null = null;
let outboxPublishTotal: Counter<string> | null = null;

export function getOutboxMetrics(registry?: Registry) {
  if (!outboxPending) {
    outboxPending = new Gauge({
      name: 'outbox_pending',
      help: 'Number of pending outbox messages waiting to be published',
      registers: registry ? [registry] : undefined,
    });
  }
  if (!outboxPublishTotal) {
    outboxPublishTotal = new Counter({
      name: 'outbox_publish_total',
      help: 'Total count of outbox messages successfully published to Kafka',
      labelNames: ['topic'] as const,
      registers: registry ? [registry] : undefined,
    });
  }
  return { outboxPending, outboxPublishTotal };
}

export class OutboxRelay {
  private running = false;
  private timer: NodeJS.Timeout | null = null;
  private metrics = getOutboxMetrics();

  constructor(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private db: any,
    private publisher: MessagePublisher,
  ) {}

  async pollOnce(batchSize = 50): Promise<number> {
    let publishedCount = 0;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle transaction type
    await this.db.transaction(async (tx: any) => {
      // Postgres SELECT ... FOR UPDATE SKIP LOCKED
      const pending: OutboxMessage[] = await tx
        .select()
        .from(outbox)
        .where(isNull(outbox.publishedAt))
        .orderBy(outbox.createdAt)
        .limit(batchSize)
        .for('update', { skipLocked: true });

      for (const msg of pending) {
        await this.publisher.publish(msg.topic, msg.key, msg.payload);
        await tx.update(outbox).set({ publishedAt: new Date() }).where(eq(outbox.id, msg.id));

        publishedCount += 1;
        this.metrics.outboxPublishTotal.labels(msg.topic).inc();
      }
    });

    try {
      const countResult = await this.db
        .select({ count: sql<number>`count(*)` })
        .from(outbox)
        .where(isNull(outbox.publishedAt));
      const remaining = Number(countResult[0]?.count ?? 0);
      this.metrics.outboxPending.set(remaining);
    } catch {
      // Non-fatal if metric query fails
    }

    return publishedCount;
  }

  start(intervalMs = 1000): void {
    if (this.running) return;
    this.running = true;

    const loop = async () => {
      if (!this.running) return;
      try {
        await this.pollOnce();
      } catch (err) {
        logger.error({ err }, 'Error during outbox relay poll');
      } finally {
        if (this.running) {
          this.timer = setTimeout(loop, intervalMs);
        }
      }
    };

    void loop();
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
