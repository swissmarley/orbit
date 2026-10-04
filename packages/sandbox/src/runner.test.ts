import { describe, expect, it } from 'vitest';
import { defaultRunner } from './runner';

const run = defaultRunner({ PATH: process.env.PATH ?? '/usr/bin:/bin', ORBIT_BASE: 'base' });

describe('defaultRunner', () => {
  it('resolves with output and a non-zero exit code instead of throwing', async () => {
    const r = await run(process.execPath, [
      '-e',
      'process.stdout.write("out"); process.stderr.write("err"); process.exit(3)',
    ]);
    expect(r).toEqual({ code: 3, stdout: 'out', stderr: 'err' });
  });

  it('passes only the given environment (plus per-call overrides)', async () => {
    const r = await run(
      process.execPath,
      ['-e', 'console.log(JSON.stringify(Object.keys(process.env).sort()))'],
      { env: { ORBIT_EXTRA: 'x' } },
    );
    expect(JSON.parse(r.stdout)).toEqual(['ORBIT_BASE', 'ORBIT_EXTRA', 'PATH']);
  });

  it('rejects when the command cannot be spawned', async () => {
    await expect(run('orbit-no-such-command-xyz', [])).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects on timeout', async () => {
    await expect(
      run(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], { timeoutMs: 200 }),
    ).rejects.toThrow(/timed out/);
  });
});
