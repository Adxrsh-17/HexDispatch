import { eq } from 'drizzle-orm';
import { idempotencyKeys, type IdempotencyRecord } from '../db/schema';
import { AppError, hashPayload } from '@hexdispatch/shared';

export interface IdempotencyResult<T = unknown> {
  cached: boolean;
  code: number;
  body: T;
}

export class IdempotencyService {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle db instance
  constructor(private db: any) {}

  async getStored(key: string, currentBody: unknown): Promise<IdempotencyResult | null> {
    const records: IdempotencyRecord[] = await this.db
      .select()
      .from(idempotencyKeys)
      .where(eq(idempotencyKeys.key, key))
      .limit(1);

    if (records.length === 0 || !records[0]) {
      return null;
    }

    const record = records[0];
    const currentHash = hashPayload(currentBody);

    if (record.requestHash !== currentHash) {
      throw new AppError(
        'IDEMPOTENCY_CONFLICT',
        'Idempotency key has already been used with a different request payload',
        422,
      );
    }

    return {
      cached: true,
      code: record.responseCode,
      body: record.responseBody,
    };
  }

  async store(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle transaction type
    tx: any,
    key: string,
    userId: string,
    body: unknown,
    responseCode: number,
    responseBody: unknown,
  ): Promise<void> {
    const requestHash = hashPayload(body);
    await tx.insert(idempotencyKeys).values({
      key,
      userId,
      requestHash,
      responseCode,
      responseBody,
      createdAt: new Date(),
    });
  }
}
