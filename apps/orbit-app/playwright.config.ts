import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests against a real orbitd (mock driver, ORBIT_PORT=0, a
 * throwaway ORBIT_HOME) serving the built App: `pnpm --filter @orbit/app
 * build && pnpm --filter @orbit/app e2e`. No credentials, ever.
 */
export default defineConfig({
  testDir: 'e2e',
  testMatch: '*.e2e.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 45_000,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  outputDir: 'test-results',
  use: {
    ...devices['Desktop Chrome'],
    viewport: { width: 1280, height: 800 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
