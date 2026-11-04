import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url:
      process.env.PAYMENT_DATABASE_URL ??
      process.env.DATABASE_URL ??
      'postgres://hex:hex_dev_only@localhost:5432/payment',
  },
});

