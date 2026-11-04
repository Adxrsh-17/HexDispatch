import { createDb } from '@hexdispatch/shared';
import * as schema from './schema';

export const CORE_DB_DEFAULT_URL = 'postgres://hex:hex_dev_only@localhost:5432/core';

export function getCoreDb(connectionString = process.env.DATABASE_URL ?? CORE_DB_DEFAULT_URL) {
  return createDb(connectionString, schema);
}

export * from './schema';

