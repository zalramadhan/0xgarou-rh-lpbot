import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Every test file gets a temp store and keystore, so a test can never
    // write to the real `data/store.json`.
    setupFiles: ['tests/setup.ts'],
  },
});
