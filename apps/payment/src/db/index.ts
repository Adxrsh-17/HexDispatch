import { createDb } from '@hexdispatch/shared';
import * as schema from './schema';

export const PAYMENT_DB_DEFAULT_URL =
  process.env.PAYMENT_DATABASE_URL ??
  process.env.DATABASE_URL ??
  'postgres://hex:hex_dev_only@localhost:5432/payment';

export function getPaymentDb(connectionString = PAYMENT_DB_DEFAULT_URL) {
  return createDb(connectionString, schema);
}

export * from './schema';
