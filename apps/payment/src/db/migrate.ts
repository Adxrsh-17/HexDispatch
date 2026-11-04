import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { getPaymentDb } from './index';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function runMigrations(databaseUrl?: string) {
  const { db, close } = getPaymentDb(databaseUrl);
  try {
    const migrationsFolder = path.resolve(__dirname, '../../drizzle/migrations');
    await migrate(db, { migrationsFolder });
  } finally {
    await close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runMigrations()
    .then(() => {
      console.log('Payment migrations completed successfully.');
      process.exit(0);
    })
    .catch((err) => {
      console.error('Payment migration failed:', err);
      process.exit(1);
    });
}

