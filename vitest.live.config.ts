import { defineConfig } from 'vitest/config';

// Opt-in tests that talk to a real engine (API key or logged-in `claude`).
// Never run in CI. Usage: `pnpm test:live`.
export default defineConfig({
  test: {
    name: 'live',
    include: ['packages/**/*.live.test.ts', 'apps/**/*.live.test.ts'],
    testTimeout: 180_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
