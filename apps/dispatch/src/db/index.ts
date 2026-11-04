import { createDb } from '@hexdispatch/shared';
import * as schema from './schema';

export const DISPATCH_DB_DEFAULT_URL =
  process.env.DISPATCH_DATABASE_URL ??
  process.env.DATABASE_URL ??
  'postgres://hex:hex_dev_only@localhost:5432/dispatch';

export function getDispatchDb(connectionString = DISPATCH_DB_DEFAULT_URL) {
  return createDb(connectionString, schema);
}

export * from './schema';
