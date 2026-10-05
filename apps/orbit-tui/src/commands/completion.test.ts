import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OrbitClient } from '@orbit/sdk-client';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../cli';
import type { Io } from '../io';
import {
  COMPLETE_TIMEOUT_MS,
  bashCompletion,
  completeNames,
  completionTree,
  fishCompletion,
  safeCandidates,
  zshCompletion,
} from './completion';

function io(home: string, startDaemon?: Io['startDaemon']) {
  const out: string[] = [];
  const err: string[] = [];
  const value: Io = {
    out: (t) => out.push(t),
    err: (t) => err.push(t),
    env: { ORBIT_HOME: home, ORBIT_DRIVER: 'mock' },
    color: false,
    onInterrupt: () => () => undefined,
    ...(startDaemon ? { startDaemon } : {}),
  };
  return { io: value, out, err };
}

/** A client over canned answers (only what `__complete` calls). */
function cannedClient(over: Partial<Record<'bots' | 'runs' | 'approvals' | 'plugins', unknown>>) {
  const ok = (v: unknown) => () => Promise.resolve(v);
  return {
    bots: { list: ok(over.bots ?? []) },
    runs: { list: ok(over.runs ?? []) },
    approvals: { list: ok(over.approvals ?? []) },
    plugins: { list: ok(over.plugins ?? []) },
  } as unknown as OrbitClient;
}

describe('orbit __complete (dynamic candidates, M8)', () => {
  let home: string;
  let server: Server | undefined;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'orbit-complete-'));
  });
  afterEach(async () => {
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
    server = undefined;
    rmSync(home, { recursive: true, force: true });
  });

  it('prints one candidate per line and skips names with shell metacharacters', async () => {
    const t = io(home);
    const client = cannedClient({
      bots: [
        { spec: { name: 'Inbox Triage' } },
        { spec: { name: 'Notes' } },
        { spec: { name: '$(touch pwned)' } },
      ],
      runs: [{ runId: 'run_01ABC' }, { runId: 'run_`id`' }],
      approvals: [{ id: 'apr_1' }],
      plugins: [{ id: 'github' }, { id: 'evil;rm' }],
    });
    for (const [kind, expected] of [
      ['bots', ['inbox-triage', 'notes', 'touch-pwned']],
      ['runs', ['run_01ABC']],
      ['approvals', ['apr_1']],
      ['plugins', ['github']],
    ] as const) {
      t.out.length = 0;
      expect(await completeNames(t.io, kind, () => client)).toBe(0);
      expect(t.out).toEqual(expected);
    }
    expect(safeCandidates(['ok', 'a b', "it's", 'x$y', '-rf', 'ok', 'é'])).toEqual(['ok']);
  });

  it('prints nothing and exits 0 for an unknown kind or a failing daemon', async () => {
    const t = io(home);
    const failing = {
      bots: { list: () => Promise.reject(new Error('boom')) },
    } as unknown as OrbitClient;
    expect(await completeNames(t.io, 'secrets', () => cannedClient({}))).toBe(0);
    expect(await completeNames(t.io, undefined, () => cannedClient({}))).toBe(0);
    expect(await completeNames(t.io, 'bots', () => failing)).toBe(0);
    expect(t.out).toEqual([]);
    expect(t.err).toEqual([]);
  });

  it('no daemon: prints nothing, exits 0 and never starts one', async () => {
    const startDaemon = vi.fn(() => Promise.resolve());
    const t = io(home, startDaemon);
    for (const args of [['__complete', 'bots'], ['__complete'], ['__complete', 'runs', 'extra']]) {
      expect(await main(args, t.io)).toBe(0);
    }
    expect(startDaemon).not.toHaveBeenCalled();
    expect(t.out).toEqual([]);
    expect(t.err).toEqual([]);
    expect(existsSync(join(home, 'daemon.json'))).toBe(false);
  });

  it('gives up on a daemon that does not answer within the timeout', async () => {
    server = createServer(() => undefined); // accepts, never answers
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
    const { port } = server.address() as AddressInfo;
    writeFileSync(
      join(home, 'daemon.json'),
      JSON.stringify({ pid: 1, url: `http://127.0.0.1:${port}`, startedAt: 'x', version: '0' }),
    );
    writeFileSync(join(home, 'daemon.token'), 'token', { mode: 0o600 });
    const t = io(home);
    const start = Date.now();
    expect(await main(['__complete', 'bots'], t.io)).toBe(0);
    expect(Date.now() - start).toBeLessThan(COMPLETE_TIMEOUT_MS + 1500);
    expect(t.out).toEqual([]);
    expect(t.err).toEqual([]);
  });

  it('is hidden from help and from the completion scripts themselves', async () => {
    const t = io(home);
    await main(['--help'], t.io);
    expect(t.out.join('\n')).not.toMatch(/__complete/);
    t.out.length = 0;
    await main(['completion', 'bash'], t.io);
    expect(t.out.join('\n')).not.toMatch(/"__complete"/);
  });
});

describe('completion scripts call the helper for Bot, Run, approval and plugin arguments', () => {
  const root = (() => {
    const p = new Command('orbit');
    p.command('run').argument('<bot>', 'bot name or id');
    p.command('tail').argument('<run>', 'run id');
    p.command('approve').argument('<id>', 'approval id');
    p.command('plugin').command('enable').argument('<id>', 'plugin id');
    p.command('memory').command('show').argument('<id>', 'memory id');
    p.command('__complete', { hidden: true });
    return completionTree(p);
  })();

  it('bash and zsh mark the arguments; fish completes them with a command substitution', () => {
    const bash = bashCompletion(root);
    expect(bash).toContain('"run") opts="--help" dyn="bots" ;;');
    expect(bash).toContain('"tail") opts="--help" dyn="runs" ;;');
    expect(bash).toContain('"approve") opts="--help" dyn="approvals" ;;');
    expect(bash).toContain('"plugin enable") opts="--help" dyn="plugins" ;;');
    expect(bash).toContain('"memory show") opts="--help" ;;');
    expect(bash).toContain('$(command orbit __complete "$dyn" 2>/dev/null)');
    const zsh = zshCompletion(root);
    expect(zsh).toContain('"run") opts=(--help) dyn=bots ;;');
    expect(zsh).toContain('$(command orbit __complete $dyn 2>/dev/null)');
    const fish = fishCompletion(root);
    expect(fish).toContain(
      "complete -c orbit -f -n '__fish_seen_subcommand_from enable' -a '(command orbit __complete plugins 2>/dev/null)'",
    );
    expect(bash + zsh + fish).not.toMatch(/'__complete'|"__complete"\)/);
  });

  it('bash offers the candidates for the first argument only', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orbit-complete-bash-'));
    try {
      // A stand-in `orbit` on PATH: what a running daemon would answer.
      const fake = join(dir, 'orbit');
      writeFileSync(
        fake,
        '#!/bin/sh\n[ "$1" = __complete ] && [ "$2" = bots ] && printf "notes\\nmailer\\n"\nexit 0\n',
      );
      chmodSync(fake, 0o755);
      const script = join(dir, 'orbit.bash');
      writeFileSync(script, bashCompletion(root));
      const complete = (...words: string[]) =>
        spawnSync(
          'bash',
          [
            '-c',
            `source ${script}; COMP_WORDS=(orbit ${words.map((w) => `'${w}'`).join(' ')}); COMP_CWORD=${words.length}; _orbit_complete; printf '%s\\n' "\${COMPREPLY[@]}"`,
          ],
          { encoding: 'utf8', env: { PATH: `${dir}:${process.env.PATH ?? ''}` } },
        )
          .stdout.trim()
          .split('\n')
          .filter(Boolean);
      expect(complete('run', '')).toEqual(['--help', 'notes', 'mailer']);
      expect(complete('run', 'no')).toEqual(['notes']);
      expect(complete('run', '--')).toEqual(['--help']);
      expect(complete('run', 'notes', '')).toEqual(['--help']);
      expect(complete('tail', '')).toEqual(['--help']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('completion name guard (names end up inside shell quotes)', () => {
  it('accepts plain command and option names', () => {
    const p = new Command('orbit');
    p.command('bot-run').option('--json');
    expect(completionTree(p).children[0]?.name).toBe('bot-run');
  });

  it('positive control: refuses names that could break out of shell quotes', () => {
    const evil = new Command('orbit');
    evil.command("x';rm -rf ~;'");
    expect(() => completionTree(evil)).toThrow(/Unsafe command name/);
    const evilOption = new Command('orbit');
    evilOption.command('ok').option('--a$(id)');
    expect(() => completionTree(evilOption)).toThrow(/Unsafe option/);
  });
});
