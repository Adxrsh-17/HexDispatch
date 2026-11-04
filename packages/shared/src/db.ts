import postgres from 'postgres';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';

export type DbClient<TSchema extends Record<string, unknown> = Record<string, unknown>> =
  PostgresJsDatabase<TSchema>;

export interface DatabaseConnection<
  TSchema extends Record<string, unknown> = Record<string, unknown>,
> {
  db: DbClient<TSchema>;
  client: postgres.Sql;
  close: () => Promise<void>;
}

export function createDb<TSchema extends Record<string, unknown> = Record<string, unknown>>(
  connectionString: string,
  schema?: TSchema,
): DatabaseConnection<TSchema> {
  const client = postgres(connectionString, {
    max: 10,
    idle_timeout: 20,
    connect_timeout: 10,
  });

  const db = drizzle(client, { schema });

  return {
    db,
    client,
    close: async () => {
      await client.end();
    },
  };
}
