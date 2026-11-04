import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['{apps,packages,tools}/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    // Testcontainers integration tests (*.int.test.ts) get a longer budget.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
