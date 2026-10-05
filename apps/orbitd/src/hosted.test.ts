import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { type IncomingMessage, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OrbitConfig, type OrbitConfigInput } from '@orbit/core';
import { daemonFiles, readDaemonInfo } from '@orbit/sdk-client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Daemon, planListen, startDaemon } from './daemon';

/**
 * Hosted mode and the container bind at the daemon (ADR-015): the startup
 * rules with their hints, in-process TLS with a throwaway certificate, the
 * published address, the Host allowlist and doctor.
 */

const PUBLIC = 'https://orbit.test';
const HOSTED = {
  ORBIT_MODE: 'hosted',
  ORBIT_PUBLIC_URL: PUBLIC,
  ORBIT_OIDC_ISSUER: 'https://id.example.com',
  ORBIT_OIDC_CLIENT_ID: 'orbit',
};

function hasOpenssl(): boolean {
  try {
    execFileSync('openssl', ['version'], {
      env: { PATH: process.env.PATH ?? '' },
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}
const OPENSSL = hasOpenssl();

/** A throwaway self-signed certificate for orbit.test and 127.0.0.1 (never committed). */
function selfSigned(dir: string): { cert: string; key: string } {
  const cert = join(dir, 'cert.pem');
  const key = join(dir, 'key.pem');
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      key,
      '-out',
      cert,
      '-days',
      '1',
      '-subj',
      '/CN=orbit.test',
      '-addext',
      'subjectAltName=DNS:orbit.test,IP:127.0.0.1',
    ],
    { env: { PATH: process.env.PATH ?? '' }, stdio: 'ignore' },
  );
  return { cert, key };
}

interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function get(
  port: number,
  path: string,
  opts: { tls?: { ca: Buffer }; headers?: Record<string, string> } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const common = { host: '127.0.0.1', port, path, headers: opts.headers ?? {} };
    const onResponse = (res: IncomingMessage) => {
      let body = '';
      res.on('data', (d: Buffer) => (body += d.toString()));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    };
    const req = opts.tls
      ? httpsRequest({ ...common, ca: opts.tls.ca, servername: 'orbit.test' }, onResponse)
      : httpRequest(common, onResponse);
    req.on('error', reject);
    req.end();
  });
}

/** The OrbitError a call throws (code, message, hint), or null. */
function refusal(fn: () => unknown): { code: string; message: string; hint: string } | null {
  try {
    fn();
  } catch (err) {
    return err as { code: string; message: string; hint: string };
  }
  return null;
}

describe('orbitd listen rules (ADR-015)', () => {
  const config = (c: Partial<OrbitConfigInput>) => OrbitConfig.parse({ home: '/tmp/x', ...c });
  const hosted = (c: Partial<OrbitConfigInput> = {}) =>
    config({
      mode: 'hosted',
      hosted: {
        publicUrl: PUBLIC,
        oidc: { issuer: 'https://id.example.com', clientId: 'orbit' },
      },
      ...c,
    });
  const yes = () => true;
  const no = () => false;

  it('local mode: loopback, or every interface inside a container that says so', () => {
    expect(planListen(config({}), {}, no)).toMatchObject({
      tls: null,
      container: false,
      publishedHost: '127.0.0.1',
    });
    const c = planListen(config({ api: { host: '0.0.0.0' } }), { ORBIT_CONTAINER: '1' }, yes);
    expect(c).toMatchObject({ container: true, publishedHost: '127.0.0.1', publicUrl: null });
    expect(
      planListen(config({ api: { host: '::' } }), { ORBIT_CONTAINER: '1' }, yes).container,
    ).toBe(true);
  });

  it.each<{
    scenario: string;
    host: string;
    env: Record<string, string>;
    marker: boolean;
    message: RegExp;
    hint: RegExp;
  }>([
    {
      scenario: 'a container bind without ORBIT_CONTAINER=1',
      host: '0.0.0.0',
      env: {},
      marker: true,
      message: /only listens on loopback in local mode/,
      hint: /ORBIT_CONTAINER=1/,
    },
    {
      scenario: 'ORBIT_CONTAINER=1 outside a container',
      host: '0.0.0.0',
      env: { ORBIT_CONTAINER: '1' },
      marker: false,
      message: /not a container/,
      hint: /127\.0\.0\.1/,
    },
    {
      scenario: 'a specific address inside a container',
      host: '172.17.0.2',
      env: { ORBIT_CONTAINER: '1' },
      marker: true,
      message: /only listens on loopback/,
      hint: /0\.0\.0\.0.*127\.0\.0\.1:7420:7420/,
    },
  ])('refuses $scenario', ({ host, env, marker, message, hint }) => {
    const r = refusal(() => planListen(config({ api: { host } }), env, () => marker));
    expect(r?.code).toBe('invalid_config');
    expect(r?.message).toMatch(message);
    expect(r?.hint).toMatch(hint);
  });

  it('hosted mode needs a public URL and OIDC, refuses the CliDriver, and TLS off loopback', () => {
    const plan = (c: OrbitConfig) => refusal(() => planListen(c, {}, no));
    const noUrl = plan(config({ mode: 'hosted' }));
    expect(noUrl).toMatchObject({
      code: 'invalid_config',
      message: 'Hosted mode needs its public https URL',
    });
    expect(noUrl?.hint).toMatch(/ORBIT_PUBLIC_URL/);
    const noOidc = plan(config({ mode: 'hosted', hosted: { publicUrl: PUBLIC } }));
    expect(noOidc?.message).toBe('Hosted mode needs OIDC sign-in');
    expect(noOidc?.hint).toContain(`${PUBLIC}/v1/auth/oidc/callback`);
    const cli = plan(hosted({ driver: 'cli' }));
    expect(cli?.code).toBe('compliance_refused');
    expect(cli?.hint).toMatch(/API key/);
    const open = plan(hosted({ api: { host: '0.0.0.0' } }));
    expect(open?.message).toBe('orbitd listens on 0.0.0.0 only with TLS');
    expect(open?.hint).toMatch(/ORBIT_TLS_CERT.*reverse proxy/);
    // Behind a TLS-terminating proxy on the same machine: allowed.
    expect(planListen(hosted(), {}, no)).toMatchObject({
      tls: null,
      publishedHost: '127.0.0.1',
      publicUrl: PUBLIC,
    });
    // SDK and mock engines are fine.
    expect(plan(hosted({ driver: 'mock' }))).toBeNull();
    expect(plan(hosted({ driver: 'sdk' }))).toBeNull();
    // An unreadable certificate is named, never read into the message.
    expect(
      plan(
        hosted({
          api: { host: '0.0.0.0' },
          hosted: {
            publicUrl: PUBLIC,
            oidc: { issuer: 'https://id.example.com', clientId: 'orbit' },
            tls: { certFile: '/nope/cert.pem', keyFile: '/nope/key.pem' },
          },
        }),
      ),
    ).toMatchObject({ message: /Cannot read the TLS certificate \/nope\/cert\.pem: ENOENT/ });
  });
});

describe('orbitd hosted and container daemons (ADR-015)', () => {
  let home: string;
  let daemon: Daemon | undefined;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'orbitd-hosted-'));
  });
  afterEach(async () => {
    await daemon?.stop();
    daemon = undefined;
    rmSync(home, { recursive: true, force: true });
  });
  const start = (extra: Record<string, string>, inContainer = () => false) =>
    startDaemon({
      env: { ORBIT_HOME: home, ORBIT_DRIVER: 'mock', PATH: process.env.PATH ?? '', ...extra },
      port: 0,
      log: () => undefined,
      service: { vaultKeySource: 'file' },
      inContainer,
    });
  const token = () => readFileSync(daemonFiles(home).token, 'utf8').trim();

  it('refuses at startup, leaving no lock behind', async () => {
    await expect(start({ ORBIT_MODE: 'hosted' })).rejects.toMatchObject({
      message: /public https URL/,
    });
    await expect(start({ ...HOSTED, ORBIT_PUBLIC_URL: 'http://orbit.test' })).rejects.toMatchObject(
      { code: 'invalid_config', message: /publicUrl/ },
    );
    await expect(start({ ...HOSTED, ORBIT_DRIVER: 'cli' })).rejects.toMatchObject({
      code: 'compliance_refused',
    });
    await expect(start({ ...HOSTED, ORBIT_HOST: '0.0.0.0' })).rejects.toMatchObject({
      message: /only with TLS/,
    });
    await expect(start({ ORBIT_HOST: '0.0.0.0', ORBIT_CONTAINER: '1' })).rejects.toMatchObject({
      message: /not a container/,
    });
    expect(readDaemonInfo(home)).toBeNull();
  });

  it('container bind: every interface inside, 127.0.0.1 published, CliDriver refused', async () => {
    daemon = await start({ ORBIT_HOST: '0.0.0.0', ORBIT_CONTAINER: '1' }, () => true);
    expect(daemon.url).toBe(`http://127.0.0.1:${daemon.port}`);
    expect(readDaemonInfo(home)?.url).toBe(daemon.url);
    expect(daemon.service.url).toBe(daemon.url);
    const auth = { authorization: `Bearer ${token()}` };
    const doctor = await get(daemon.port, '/v1/doctor', { headers: auth });
    expect(doctor.status).toBe(200);
    const report = JSON.parse(doctor.body) as {
      listen: unknown;
      warnings: { code: string; message: string }[];
      compliance: { allowed: boolean; violations: string[] };
    };
    expect(report.listen).toEqual({ tls: false, container: true });
    expect(report.warnings.find((w) => w.code === 'container_bind')?.message).toMatch(
      /127\.0\.0\.1:7420:7420/,
    );
    expect(report.compliance).toMatchObject({ allowed: false, violations: ['non_loopback_bind'] });
    // The Host allowlist stays the loopback names with this port.
    const rebound = await get(daemon.port, '/v1/health', {
      headers: { host: `orbit.test:${daemon.port}` },
    });
    expect(rebound.status).toBe(403);
  });

  it('behind a reverse proxy: loopback, the public host allowed, HSTS, OIDC sign-in offered', async () => {
    daemon = await start(HOSTED);
    expect(daemon.url).toBe(`http://127.0.0.1:${daemon.port}`);
    const health = await get(daemon.port, '/v1/health', { headers: { host: 'orbit.test' } });
    expect(health.status).toBe(200);
    expect(JSON.parse(health.body)).toMatchObject({ signIn: 'oidc', publicUrl: PUBLIC });
    expect(health.headers['strict-transport-security']).toBe('max-age=31536000');
    const other = await get(daemon.port, '/v1/health', { headers: { host: 'evil.example' } });
    expect(other.status).toBe(403);
    // The bearer token is the server operator's credential: the owner.
    const who = await get(daemon.port, '/v1/session', {
      headers: { host: 'orbit.test', authorization: `Bearer ${token()}` },
    });
    expect(JSON.parse(who.body)).toEqual({
      via: 'token',
      principal: { id: 'owner', name: 'Local owner', role: 'owner' },
    });
  });

  it.skipIf(!OPENSSL)(
    'serves https with an in-process certificate',
    async () => {
      const pem = selfSigned(home);
      daemon = await start({
        ...HOSTED,
        ORBIT_HOST: '127.0.0.1',
        ORBIT_TLS_CERT: pem.cert,
        ORBIT_TLS_KEY: pem.key,
        ORBIT_OIDC_CLIENT_SECRET: 'TEST-oidc-client-secret-value',
      });
      // Clients on this machine use the name the certificate is for.
      expect(daemon.url).toBe(PUBLIC);
      expect(readDaemonInfo(home)?.url).toBe(PUBLIC);
      const ca = readFileSync(pem.cert);
      const health = await get(daemon.port, '/v1/health', {
        tls: { ca },
        headers: { host: 'orbit.test' },
      });
      expect(health.status).toBe(200);
      expect(JSON.parse(health.body)).toMatchObject({ signIn: 'oidc', publicUrl: PUBLIC });
      expect(health.headers['strict-transport-security']).toBe('max-age=31536000');
      const doctor = await get(daemon.port, '/v1/doctor', {
        tls: { ca },
        headers: { host: 'orbit.test', authorization: `Bearer ${token()}` },
      });
      expect(JSON.parse(doctor.body)).toMatchObject({
        mode: 'hosted',
        hosted: { publicUrl: PUBLIC, issuer: 'https://id.example.com', tls: true },
        principals: { owner: 1, operator: 0, viewer: 0 },
        listen: { tls: true, container: false },
      });
      // Plain HTTP on the TLS port gets nowhere.
      await expect(get(daemon.port, '/v1/health')).rejects.toThrow();
      // The client secret from the environment is redacted like any credential.
      expect(daemon.service.redactor.redactString('x TEST-oidc-client-secret-value')).not.toContain(
        'TEST-oidc-client-secret-value',
      );
    },
    20_000,
  );
});
