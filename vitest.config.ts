import { defineConfig } from 'vitest/config';

// One Vitest project per workspace package plus repo-level guard tests.
// Live tests (*.live.test.ts) never run here; see vitest.live.config.ts.
export default defineConfig({
  test: {
    projects: [
      'packages/*',
      'apps/*',
      // plugins/catalog.json is the plugin catalog (ADR-019), not a project.
      'plugins/*',
      'packaging/*',
      '!plugins/catalog.json',
      {
        test: {
          name: 'repo',
          include: ['tools/**/*.test.ts'],
        },
      },
    ],
    exclude: ['**/node_modules/**', '**/dist/**', '**/*.live.test.ts', '.claude/worktrees/**'],
    passWithNoTests: false,
  },
});
