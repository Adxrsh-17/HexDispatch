import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import * as schema from '../src/db/schema';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function createTestDb() {
  const client = new PGlite();

  const migrationsDir = path.resolve(__dirname, '../drizzle/migrations');
  const sqlFiles = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const file of sqlFiles) {
    const migrationSql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');
    // Remove drizzle statement-breakpoints and execute on PGlite
    const cleanSql = migrationSql.replace(/--> statement-breakpoint/g, ';');
    await client.exec(cleanSql);
  }

  const db = drizzle(client, { schema });

  return {
    db,
    client,
    clean: async () => {
      await client.close();
    },
  };
}
