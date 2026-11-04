import { createDb } from '@hexdispatch/shared';
import * as schema from './schema';

export const PRICING_DB_DEFAULT_URL =
  process.env.PRICING_DATABASE_URL ??
  process.env.DATABASE_URL ??
  'postgres://hex:hex_dev_only@localhost:5432/pricing';

export function getPricingDb(connectionString = PRICING_DB_DEFAULT_URL) {
  return createDb(connectionString, schema);
}

export * from './schema';

