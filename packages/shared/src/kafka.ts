import type { Kafka, Producer, Consumer, EachMessagePayload } from 'kafkajs';
import { Counter, type Registry } from 'prom-client';
import { dlqTopic } from '@hexdispatch/contracts';
import { createLogger } from './logger';

const logger = createLogger({ service: 'kafka' });

export interface KafkaConfig {
  brokers: string[];
  clientId: string;
}

export interface KafkaMetrics {
  messagesTotal: Counter<string>;
  consumeErrorsTotal: Counter<string>;
  dlqTotal: Counter<string>;
}

export function createKafkaMetrics(registry?: Registry): KafkaMetrics {
  const messagesTotal = new Counter({
    name: 'kafka_messages_total',
    help: 'Total number of messages published or received',
    labelNames: ['topic', 'status'] as const,
    registers: registry ? [registry] : undefined,
  });

  const consumeErrorsTotal = new Counter({
    name: 'kafka_consume_errors_total',
    help: 'Total number of Kafka consume errors',
    labelNames: ['topic', 'consumer_group'] as const,
    registers: registry ? [registry] : undefined,
  });

  const dlqTotal = new Counter({
    name: 'kafka_dlq_total',
    help: 'Total number of messages sent to Dead Letter Queue',
    labelNames: ['topic', 'consumer_group'] as const,
    registers: registry ? [registry] : undefined,
  });

  return { messagesTotal, consumeErrorsTotal, dlqTotal };
}

export interface TypedMessage {
  topic: string;
  key: string;
  payload: unknown;
  headers?: Record<string, string>;
}

export class KafkaProducer {
  private producer: Producer;
  private connected = false;
  private metrics: KafkaMetrics;

  constructor(
    private kafka: Kafka,
    metrics?: KafkaMetrics,
  ) {
    this.producer = this.kafka.producer({
      idempotent: true,
      maxInFlightRequests: 1,
    });
    this.metrics = metrics ?? createKafkaMetrics();
  }

  async connect(): Promise<void> {
    if (!this.connected) {
      await this.producer.connect();
      this.connected = true;
    }
  }

  async disconnect(): Promise<void> {
    if (this.connected) {
      await this.producer.disconnect();
      this.connected = false;
    }
  }

  async publish(
    topic: string,
    key: string,
    payload: unknown,
    headers?: Record<string, string>,
  ): Promise<void> {
    await this.connect();
    try {
      const value = typeof payload === 'string' ? payload : JSON.stringify(payload);
      await this.producer.send({
        topic,
        messages: [{ key, value, headers }],
      });
      this.metrics.messagesTotal.labels(topic, 'published').inc();
    } catch (err) {
      this.metrics.messagesTotal.labels(topic, 'publish_error').inc();
      throw err;
    }
  }

  async publishBatch(messages: TypedMessage[]): Promise<void> {
    await this.connect();
    const grouped = new Map<
      string,
      Array<{ key: string; value: string; headers?: Record<string, string> }>
    >();
    for (const msg of messages) {
      const list = grouped.get(msg.topic) ?? [];
      const value = typeof msg.payload === 'string' ? msg.payload : JSON.stringify(msg.payload);
      list.push({ key: msg.key, value, headers: msg.headers });
      grouped.set(msg.topic, list);
    }

    const topicMessages = Array.from(grouped.entries()).map(([topic, msgs]) => ({
      topic,
      messages: msgs,
    }));

    await this.producer.sendBatch({ topicMessages });
    for (const msg of messages) {
      this.metrics.messagesTotal.labels(msg.topic, 'published').inc();
    }
  }
}

export interface ConsumerHandler<T = unknown> {
  (payload: T, raw: EachMessagePayload): Promise<void>;
}

export class KafkaConsumer {
  private consumer: Consumer;
  private connected = false;
  private metrics: KafkaMetrics;

  constructor(
    private kafka: Kafka,
    private groupId: string,
    private producer: KafkaProducer,
    metrics?: KafkaMetrics,
  ) {
    this.consumer = this.kafka.consumer({ groupId: this.groupId });
    this.metrics = metrics ?? createKafkaMetrics();
  }

  async connect(): Promise<void> {
    if (!this.connected) {
      await this.consumer.connect();
      this.connected = true;
    }
  }

  async disconnect(): Promise<void> {
    if (this.connected) {
      await this.consumer.disconnect();
      this.connected = false;
    }
  }

  async subscribe<T = unknown>(
    topics: string[],
    handler: ConsumerHandler<T>,
    options: { maxRetries?: number; initialBackoffMs?: number } = {},
  ): Promise<void> {
    const { maxRetries = 3, initialBackoffMs = 100 } = options;
    await this.connect();

    for (const topic of topics) {
      await this.consumer.subscribe({ topic, fromBeginning: false });
    }

    await this.consumer.run({
      eachMessage: async (eachMessagePayload) => {
        const { topic, message } = eachMessagePayload;
        let parsedPayload: T;
        try {
          parsedPayload = JSON.parse(message.value?.toString() ?? '{}') as T;
        } catch {
          parsedPayload = message.value?.toString() as unknown as T;
        }

        let attempt = 0;
        let lastError: unknown;

        while (attempt <= maxRetries) {
          try {
            await handler(parsedPayload, eachMessagePayload);
            this.metrics.messagesTotal.labels(topic, 'consumed').inc();
            return;
          } catch (err) {
            lastError = err;
            attempt += 1;
            this.metrics.consumeErrorsTotal.labels(topic, this.groupId).inc();
            if (attempt <= maxRetries) {
              const backoff = initialBackoffMs * Math.pow(2, attempt - 1);
              await new Promise((res) => setTimeout(res, backoff));
            }
          }
        }

        // Exhausted retries -> publish to DLQ
        const dlq = dlqTopic(this.groupId);
        logger.error(
          { topic, dlq, err: lastError, key: message.key?.toString() },
          'Message failed all retries, sending to DLQ',
        );
        this.metrics.dlqTotal.labels(topic, this.groupId).inc();
        await this.producer.publish(dlq, message.key?.toString() ?? '', {
          originalTopic: topic,
          originalPayload: parsedPayload,
          error: lastError instanceof Error ? lastError.message : String(lastError),
          failedAt: new Date().toISOString(),
        });
      },
    });
  }
}
