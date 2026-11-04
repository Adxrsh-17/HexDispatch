import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCoreApiApp } from '../apps/core-api/src/app';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const dummyDb = {
    select: () => dummyDb,
    from: () => dummyDb,
    where: () => dummyDb,
    limit: () => dummyDb,
    orderBy: () => dummyDb,
    execute: async () => {},
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Mock transaction callback
    transaction: async (cb: any) => cb(dummyDb),
  };

  const app = await buildCoreApiApp({ db: dummyDb, logLevel: 'silent' });
  await app.ready();

  // Fastify Swagger generates the full OpenAPI schema
  const openapiSpec = app.swagger();
  const outputPath = path.resolve(__dirname, '../docs/api/core-api.openapi.json');

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, JSON.stringify(openapiSpec, null, 2), 'utf-8');

  console.log(`OpenAPI specification generated successfully at ${outputPath}`);
  await app.close();
}

main().catch((err) => {
  console.error('Failed to generate OpenAPI spec:', err);
  process.exit(1);
});
