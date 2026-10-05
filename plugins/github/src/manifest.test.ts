import { readFileSync } from 'node:fs';
import { handle } from '@orbit/plugin-kit';
import { describe, expect, it } from 'vitest';
import { tools } from './tools';

interface ManifestTool {
  name: string;
  tier: string;
  description: string;
}
interface Manifest {
  id: string;
  version: string;
  tools: ManifestTool[];
  secrets: { name: string; required: boolean }[];
  settings: { name: string; default?: string }[];
  env: string[];
}

const manifest = JSON.parse(
  readFileSync(new URL('../orbit-plugin.json', import.meta.url), 'utf8'),
) as Manifest;

describe('github plugin manifest', () => {
  it('declares exactly the tools the server offers, in order, each described', async () => {
    const r = await handle(
      { name: 'github', version: manifest.version, tools },
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      { workspace: '.', env: {} },
    );
    const listed = (
      r?.result as { tools: { name: string; description: string; inputSchema: unknown }[] }
    ).tools;
    expect(listed.map((t) => t.name)).toEqual(manifest.tools.map((t) => t.name));
    for (const t of listed) {
      expect(t.description.length).toBeGreaterThan(10);
      expect(t.inputSchema).toMatchObject({ type: 'object' });
    }
    for (const t of manifest.tools) {
      expect(t.description.length).toBeGreaterThan(5);
      expect(t.description.length).toBeLessThanOrEqual(500);
    }
  });

  it('has the agreed tiers: reads READ, commits WRITE_LOCAL, everything that leaves EXTERNAL', () => {
    expect(Object.fromEntries(manifest.tools.map((t) => [t.name, t.tier]))).toEqual({
      list_issues: 'READ',
      get_issue: 'READ',
      list_pull_requests: 'READ',
      get_pull_request: 'READ',
      comment_on_issue: 'EXTERNAL',
      create_issue: 'EXTERNAL',
      create_pull_request: 'EXTERNAL',
      git_status: 'READ',
      git_diff: 'READ',
      git_log: 'READ',
      git_commit: 'WRITE_LOCAL',
      git_push: 'EXTERNAL',
    });
  });

  it('names its secret, settings and env passthrough', () => {
    expect(manifest.id).toBe('github');
    expect(manifest.secrets).toEqual([
      expect.objectContaining({ name: 'GITHUB_TOKEN', required: false }),
    ]);
    expect(manifest.settings.map((s) => [s.name, s.default])).toEqual([
      ['GITHUB_REPOSITORY', undefined],
      ['GIT_AUTHOR_NAME', 'Orbit Bot'],
      ['GIT_AUTHOR_EMAIL', 'orbit-bot@localhost'],
    ]);
    expect(manifest.env).toEqual(['GITHUB_API_URL']);
  });
});
