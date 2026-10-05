import { describe, expect, it } from 'vitest';
import { DEFAULT_SANDBOX_NEEDS, PluginSandboxNeeds, describeSandboxNeeds } from './plugin';

describe('describeSandboxNeeds', () => {
  it('reads as a sentence: commas, and "and" before the last part', () => {
    expect(describeSandboxNeeds(DEFAULT_SANDBOX_NEEDS)).toBe('no workspace and no network access');
    expect(
      describeSandboxNeeds(
        PluginSandboxNeeds.parse({
          workspace: 'write',
          network: true,
          paths: [{ name: 'BROWSER_PATH', parent: true }],
          nestedSandbox: true,
        }),
      ),
    ).toBe(
      'the workspace read-write, network access, BROWSER_PATH folders read-only and a browser with its own sandbox',
    );
  });
});
