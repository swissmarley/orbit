import type { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { spawnDaemon } from './daemon-control';

describe('spawnDaemon', () => {
  const home = mkdtempSync(join(tmpdir(), 'orbit-spawn-'));
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it('starts orbitd detached with the orbitd allowlist: no OAuth tokens, no unrelated secrets', () => {
    let captured: { args: string[]; env: Record<string, string> } | undefined;
    const fake = ((_cmd: string, args: string[], opts: { env: Record<string, string> }) => {
      captured = { args, env: opts.env };
      return { unref: () => undefined };
    }) as unknown as typeof spawn;
    spawnDaemon(
      {
        ORBIT_HOME: home,
        PATH: '/usr/bin',
        ANTHROPIC_API_KEY: 'sk-ant-api03-test',
        CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-never',
        ANTHROPIC_AUTH_TOKEN: 'never-either',
        GITHUB_TOKEN: 'ghp_unrelated',
      },
      fake,
    );
    expect(captured?.args.at(-1)).toMatch(/orbitd[/\\]src[/\\]bin\.ts$/);
    expect(captured?.env).toMatchObject({
      ORBIT_HOME: home,
      ANTHROPIC_API_KEY: 'sk-ant-api03-test',
    });
    const blob = JSON.stringify(captured?.env);
    for (const leaked of ['sk-ant-oat01-never', 'never-either', 'ghp_unrelated']) {
      expect(blob).not.toContain(leaked);
    }
  });
});
