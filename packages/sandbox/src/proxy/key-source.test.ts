import { OrbitError } from '@orbit/core';
import { describe, expect, it } from 'vitest';
import { fakeRunner } from '../../test/helpers';
import { apiKeyHelper, staticApiKey } from './key-source';

describe('staticApiKey', () => {
  it('returns the trimmed key, or null for an empty one', async () => {
    expect(await staticApiKey(' sk-ant-1 \n').get()).toBe('sk-ant-1');
    expect(await staticApiKey('  ').get()).toBeNull();
  });
});

describe('apiKeyHelper', () => {
  it('runs the helper through /bin/sh, caches for the TTL and refreshes after it', async () => {
    let n = 0;
    const run = fakeRunner(() => ({ stdout: `sk-ant-key-${++n}\n` }));
    let now = 0;
    const source = apiKeyHelper({
      command: 'vault read -field=key anthropic',
      run,
      ttlMs: 1000,
      now: () => now,
    });
    expect(await source.get()).toBe('sk-ant-key-1');
    expect(run.calls[0]).toMatchObject({
      file: '/bin/sh',
      args: ['-c', 'vault read -field=key anthropic'],
    });
    now = 999;
    expect(await source.get()).toBe('sk-ant-key-1');
    now = 1000;
    expect(await source.get()).toBe('sk-ant-key-2');
    expect(run.calls).toHaveLength(2);
  });

  it('reports every key it fetches (so orbitd can redact it), once per helper run', async () => {
    let n = 0;
    const run = fakeRunner(() => ({ stdout: `sk-ant-helper-${++n}\n` }));
    const seen: string[] = [];
    const source = apiKeyHelper({ command: 'helper', run, onKey: (k) => seen.push(k) });
    await Promise.all([source.get(), source.get()]);
    source.invalidate();
    await source.get();
    expect(seen).toEqual(['sk-ant-helper-1', 'sk-ant-helper-2']);
  });

  it('refreshes after invalidate (a 401) and shares one run between concurrent requests', async () => {
    let n = 0;
    const run = fakeRunner(() => ({ stdout: `sk-ant-key-${++n}` }));
    const source = apiKeyHelper({ command: 'helper', run });
    expect(await Promise.all([source.get(), source.get(), source.get()])).toEqual([
      'sk-ant-key-1',
      'sk-ant-key-1',
      'sk-ant-key-1',
    ]);
    source.invalidate();
    expect(await source.get()).toBe('sk-ant-key-2');
    expect(run.calls).toHaveLength(2);
  });

  it('fails without repeating the helper output or stderr', async () => {
    const cases = [
      fakeRunner(() => ({
        code: 1,
        stdout: 'sk-ant-partial',
        stderr: 'token sk-ant-leak expired',
      })),
      fakeRunner(() => ({ stdout: '' })),
      fakeRunner(() => ({ stdout: 'two words' })),
      fakeRunner(() => new Error('spawn /bin/sh ENOENT sk-ant-leak')),
    ];
    for (const run of cases) {
      const source = apiKeyHelper({ command: 'helper', run });
      const err = await source.get().then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(OrbitError);
      const e = err as OrbitError;
      expect(e.code).toBe('auth_required');
      expect(`${e.message} ${e.hint ?? ''}`).not.toMatch(/sk-ant|two words/);
      expect(e.hint).toMatch(/ORBIT_API_KEY_HELPER/);
    }
  });
});
