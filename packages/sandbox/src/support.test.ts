import { describe, expect, it } from 'vitest';
import { fakeRunner } from '../test/helpers';
import { detectSandboxSupport } from './support';

const dockerOk = fakeRunner(() => ({ stdout: '29.6.2\n' }));
const has =
  (...paths: string[]) =>
  (p: string) =>
    paths.includes(p);

describe('detectSandboxSupport', () => {
  it('linux: available when bwrap and socat are on PATH', async () => {
    const s = await detectSandboxSupport(dockerOk, {
      platform: 'linux',
      pathEnv: '/usr/local/bin:/usr/bin',
      exists: has('/usr/bin/bwrap', '/usr/local/bin/socat'),
    });
    expect(s.engineSandbox).toEqual({ available: true, missing: [], platform: 'linux' });
  });

  it('linux: reports each missing tool', async () => {
    const none = await detectSandboxSupport(dockerOk, {
      platform: 'linux',
      pathEnv: '/usr/bin',
      exists: has(),
    });
    expect(none.engineSandbox).toEqual({
      available: false,
      missing: ['bwrap', 'socat'],
      platform: 'linux',
    });
    const noSocat = await detectSandboxSupport(dockerOk, {
      platform: 'linux',
      pathEnv: '/usr/bin',
      exists: has('/usr/bin/bwrap'),
    });
    expect(noSocat.engineSandbox.missing).toEqual(['socat']);
  });

  it('darwin: needs /usr/bin/sandbox-exec', async () => {
    const yes = await detectSandboxSupport(dockerOk, {
      platform: 'darwin',
      exists: has('/usr/bin/sandbox-exec'),
    });
    expect(yes.engineSandbox).toEqual({ available: true, missing: [], platform: 'darwin' });
    const no = await detectSandboxSupport(dockerOk, { platform: 'darwin', exists: has() });
    expect(no.engineSandbox).toEqual({
      available: false,
      missing: ['sandbox-exec'],
      platform: 'darwin',
    });
  });

  it('other platforms: unavailable', async () => {
    const s = await detectSandboxSupport(dockerOk, { platform: 'win32', exists: () => true });
    expect(s.engineSandbox.available).toBe(false);
    expect(s.engineSandbox.missing[0]).toMatch(/win32/);
  });

  it('docker present: reports the server version', async () => {
    const s = await detectSandboxSupport(dockerOk, { platform: 'linux', exists: has() });
    expect(s.docker).toEqual({ available: true, version: '29.6.2', error: null });
    expect(dockerOk.calls[0]).toMatchObject({
      file: 'docker',
      args: ['version', '--format', '{{.Server.Version}}'],
    });
  });

  it('docker CLI present but daemon down', async () => {
    const run = fakeRunner(() => ({
      code: 1,
      stderr: 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock\n',
    }));
    const s = await detectSandboxSupport(run, { platform: 'linux', exists: has() });
    expect(s.docker.available).toBe(false);
    expect(s.docker.version).toBeNull();
    expect(s.docker.error).toMatch(/Cannot connect to the Docker daemon/);
  });

  it('docker CLI absent', async () => {
    const run = fakeRunner(() =>
      Object.assign(new Error('spawn docker ENOENT'), { code: 'ENOENT' }),
    );
    const s = await detectSandboxSupport(run, { platform: 'linux', exists: has() });
    expect(s.docker).toEqual({
      available: false,
      version: null,
      error: 'docker CLI not found on PATH',
    });
  });
});
