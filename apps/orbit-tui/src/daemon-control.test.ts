import type { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveLayout } from '@orbit/runtime';
import { afterEach, describe, expect, it } from 'vitest';
import { spawnDaemon } from './daemon-control';

describe('spawnDaemon', () => {
  const home = mkdtempSync(join(tmpdir(), 'orbit-spawn-'));
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it('starts orbitd detached with the orbitd allowlist: no OAuth tokens, no unrelated secrets, the key on stdin', () => {
    let captured:
      { args: string[]; env: Record<string, string>; stdio: unknown[]; stdin: string } | undefined;
    const fake = ((
      _cmd: string,
      args: string[],
      opts: { env: Record<string, string>; stdio: unknown[] },
    ) => {
      captured = { args, env: opts.env, stdio: opts.stdio, stdin: '' };
      const c = captured;
      return {
        unref: () => undefined,
        stdin: {
          on: () => undefined,
          end: (s: string) => {
            c.stdin += s;
          },
        },
      };
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
    expect(captured?.env).toMatchObject({ ORBIT_HOME: home, ORBIT_API_KEY_HANDOVER: 'stdin' });
    // The key travels on orbitd's standard input, never in its environment.
    expect(captured?.stdio[0]).toBe('pipe');
    expect(captured?.stdin).toBe('sk-ant-api03-test\n');
    const blob = JSON.stringify(captured?.env);
    for (const leaked of [
      'sk-ant-api03-test',
      'sk-ant-oat01-never',
      'never-either',
      'ghp_unrelated',
    ]) {
      expect(blob).not.toContain(leaked);
    }
  });

  it('without a key orbitd gets no stdin pipe and no handover (an inherited one is dropped)', () => {
    let captured: { env: Record<string, string>; stdio: unknown[] } | undefined;
    const fake = ((_cmd: string, _args: string[], opts: typeof captured) => {
      captured = opts;
      return { unref: () => undefined };
    }) as unknown as typeof spawn;
    spawnDaemon({ ORBIT_HOME: home, PATH: '/usr/bin', ORBIT_API_KEY_HANDOVER: 'pid:1' }, fake);
    expect(captured?.stdio[0]).toBe('ignore');
    expect(captured?.env).not.toHaveProperty('ORBIT_API_KEY_HANDOVER');
  });

  it('the npm package starts its bundled orbitd.mjs with plain node: no tsx (ADR-017)', () => {
    let captured: { cmd: string; args: string[] } | undefined;
    const fake = ((cmd: string, args: string[]) => {
      captured = { cmd, args };
      return { unref: () => undefined };
    }) as unknown as typeof spawn;
    const { args } = resolveLayout('packaged', '/opt/orbit-bots/dist').orbitd;
    spawnDaemon({ ORBIT_HOME: home, PATH: '/usr/bin' }, fake, args);
    expect(captured).toEqual({ cmd: process.execPath, args: ['/opt/orbit-bots/dist/orbitd.mjs'] });
  });
});
