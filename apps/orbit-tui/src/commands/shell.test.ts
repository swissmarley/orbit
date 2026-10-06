import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { NO_GIT_DIR, takeoverShellEnv } from './shell';

const root = mkdtempSync(join(tmpdir(), 'orbit-takeover-git-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const hasGit = spawnSync('git', ['--version'], { stdio: 'ignore' }).status === 0;

describe.skipIf(!hasGit)(
  'a directory Bot taken over: git runs nothing a Bot planted (M8 safety re-review)',
  () => {
    it('a repository the Bot nested in a subfolder is invisible to git in the owner’s shell', () => {
      const ws = join(root, 'workspaces', 'notes');
      const sub = join(ws, 'sub');
      mkdirSync(sub, { recursive: true });
      const marker = join(root, 'fsmonitor-ran');
      const hook = join(root, 'fsmonitor.sh');
      writeFileSync(hook, `#!/bin/sh\ntouch '${marker}'\n`);
      chmodSync(hook, 0o755);
      const git = (args: string[], env: Record<string, string>) =>
        spawnSync('git', args, { cwd: sub, env, encoding: 'utf8' });
      const base = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: root };
      expect(git(['init', '-q'], base).status).toBe(0);
      expect(git(['config', 'core.fsmonitor', hook], base).status).toBe(0);

      const env = takeoverShellEnv(base, { workspace: ws, git: null });
      expect(env.GIT_DIR).toBe(NO_GIT_DIR);
      const r = git(['status'], env);
      expect(r.status).not.toBe(0); // "not a git repository"
      expect(existsSync(marker)).toBe(false);

      // Positive control: with only the ceiling (the earlier rule) the planted command runs.
      const ceilingOnly = { ...env };
      delete ceilingOnly.GIT_DIR;
      git(['status'], ceilingOnly);
      expect(existsSync(marker)).toBe(true);
    });
  },
);
