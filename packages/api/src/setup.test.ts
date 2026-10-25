import {
  linkSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type AuthProbes, loadConfig } from '@orbit/runtime';
import { TOKEN, type Harness, harness } from '../test/harness';
import { ConfigureSetupBody, type SetupState } from './contract';
import { SETUP_API_KEY } from './service';

const KEY = 'sk-ant-api03-onboarding-test-not-a-real-credential-12345';
const noCli: AuthProbes = {
  findClaude: () => Promise.resolve(null),
  cliStatus: () => Promise.reject(new Error('not installed')),
  findBwrap: () => null,
};
let h: Harness | undefined;
const dirs: string[] = [];
afterEach(async () => {
  await h?.close();
  h = undefined;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup(options: Parameters<typeof harness>[0] = {}) {
  h = harness({ ...options, service: { probes: noCli, ...options.service } });
  return h;
}

describe('guided engine setup', () => {
  it('saves a private config and encrypted key, applies without a model call, and survives a restart', async () => {
    const home = mkdtempSync(join(tmpdir(), 'orbit-setup-'));
    dirs.push(home);
    const queryFn = vi.fn();
    const envKey = process.env.ANTHROPIC_API_KEY;
    const s = setup({ home, service: { queryFn } });
    const configFile = join(home, 'config.json');
    writeFileSync(
      configFile,
      JSON.stringify({
        api: { port: 12345 },
        models: { triage: 'haiku' },
        memory: { maxPerBot: 99 },
      }),
    );
    const oldEngine = await s.service.ensureEngine();
    expect(oldEngine.handle.driver.kind).toBe('mock');
    const res = await s.json<SetupState>('POST', '/v1/setup', {
      mode: 'api',
      model: 'sonnet',
      apiKey: KEY,
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      apiKeyStored: true,
      canConfigure: true,
      doctor: { driver: 'sdk', models: { default: 'sonnet' } },
    });
    expect(JSON.stringify(res.body)).not.toContain(KEY);
    expect(s.service.vault.get(SETUP_API_KEY)).toBe(KEY);
    expect(readFileSync(join(home, 'orbit.db')).includes(Buffer.from(KEY))).toBe(false);
    expect(JSON.stringify(s.service.auditTail(undefined, 100))).not.toContain(KEY);
    expect(readFileSync(configFile, 'utf8')).not.toContain(KEY);
    expect(JSON.parse(readFileSync(configFile, 'utf8'))).toEqual({
      api: { port: 12345 },
      driver: 'sdk',
      models: { default: 'sonnet', triage: 'haiku' },
      memory: { maxPerBot: 99 },
    });
    expect(statSync(configFile).mode & 0o777).toBe(0o600);
    expect((await s.service.ensureEngine()).handle.driver.kind).toBe('sdk');
    expect(queryFn).not.toHaveBeenCalled();
    expect(process.env.ANTHROPIC_API_KEY).toBe(envKey);
    await s.close();
    const config = loadConfig({ ORBIT_HOME: home, PATH: '' });
    const reloaded = setup({ home, config, service: { queryFn } });
    expect(await reloaded.service.getSetup()).toMatchObject({
      apiKeyStored: true,
      doctor: { driver: 'sdk', models: { default: 'sonnet' } },
    });
    expect(queryFn).not.toHaveBeenCalled();
  });

  it('reuses a saved key, can return to demo, and explicitly forgets the key permanently', async () => {
    const home = mkdtempSync(join(tmpdir(), 'orbit-setup-'));
    dirs.push(home);
    const s = setup({ home });
    expect((await s.json('POST', '/v1/setup', { mode: 'api', apiKey: KEY })).status).toBe(200);
    expect((await s.json<SetupState>('POST', '/v1/setup', { mode: 'demo' })).body).toMatchObject({
      apiKeyStored: true,
      doctor: { driver: 'mock' },
    });
    expect(
      (await s.json<SetupState>('POST', '/v1/setup', { mode: 'api' })).body.doctor.driver,
    ).toBe('sdk');
    expect(
      (await s.json('PUT', `/v1/secrets/${SETUP_API_KEY}`, { value: 'a different secret' })).status,
    ).toBe(400);
    expect((await s.json('DELETE', `/v1/secrets/${SETUP_API_KEY}`)).status).toBe(400);
    const forgotten = await s.json<SetupState>('POST', '/v1/setup', {
      mode: 'demo',
      forgetApiKey: true,
    });
    expect(forgotten.body).toMatchObject({
      apiKeyStored: false,
      doctor: { driver: 'mock', apiCredential: null },
    });
    expect(s.service.vault.has(SETUP_API_KEY)).toBe(false);
    await s.close();
    const reloaded = setup({ home, config: loadConfig({ ORBIT_HOME: home, PATH: '' }) });
    expect(await reloaded.service.getSetup()).toMatchObject({
      apiKeyStored: false,
      doctor: { driver: 'mock', apiCredential: null },
    });
    expect((await reloaded.json('POST', '/v1/setup', { mode: 'api' })).status).toBe(503);
  });

  it('rejects missing or invalid credentials without echoing or saving them', async () => {
    const s = setup();
    expect((await s.json('POST', '/v1/setup', { mode: 'api' })).status).toBe(503);
    for (const key of ['', 'invalid-secret-value', 'sk-ant-contains whitespace-in-key']) {
      const res = await s.json('POST', '/v1/setup', { mode: 'api', apiKey: key });
      expect(res.status).toBe(400);
      if (key) expect(JSON.stringify(res.body)).not.toContain(key);
    }
    expect(
      (await s.json('POST', '/v1/setup', { mode: 'api', apiKey: KEY, forgetApiKey: true })).status,
    ).toBe(400);
    expect((await s.json('POST', '/v1/setup', { mode: 'demo', apiKey: KEY })).status).toBe(400);
    expect(s.service.vault.has(SETUP_API_KEY)).toBe(false);
    expect(s.service.config.driver).toBe('mock');
    expect((await s.json('POST', '/v1/setup', { mode: 'cli' })).status).toBe(503);
    expect(s.service.config.driver).toBe('mock');
  });

  it('connects an existing Claude Code login without reading its credentials or starting a model call', async () => {
    const s = setup({
      service: {
        probes: {
          ...noCli,
          findClaude: () => Promise.resolve('/fake/claude'),
          cliStatus: (path) =>
            Promise.resolve({
              path,
              loggedIn: true,
              authMethod: 'oauth_token',
              apiProvider: 'firstParty',
              version: '2.1.0',
              error: null,
            }),
        },
      },
    });
    const res = await s.json<SetupState>('POST', '/v1/setup', { mode: 'cli' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      apiKeyStored: false,
      doctor: { driver: 'cli', authMethod: 'subscription', cli: { loggedIn: true } },
    });
    expect(JSON.parse(readFileSync(join(s.home, 'config.json'), 'utf8'))).toMatchObject({
      driver: 'cli',
      models: { default: 'sonnet' },
    });
  });

  it('only permits authenticated owners and keeps cross-origin access blocked', async () => {
    const s = setup();
    expect((await s.app.request('/v1/setup')).status).toBe(401);
    const res = await s.call(
      'POST',
      '/v1/setup',
      { mode: 'demo' },
      { origin: 'https://evil.example' },
    );
    expect(res.status).toBe(403);
    expect(
      (await s.app.request('/v1/setup', { headers: { authorization: `Bearer ${TOKEN}` } })).status,
    ).toBe(200);
  });

  it('disables setup for hosted installations', async () => {
    const hosted = setup({ config: { mode: 'hosted' } });
    const hostedState = await hosted.service.getSetup();
    expect(hostedState.canConfigure).toBe(false);
    expect(hostedState.reason).toMatch(/administrator/);
    expect((await hosted.json('POST', '/v1/setup', { mode: 'demo' })).status).toBe(409);
  });

  it.each([
    ['ORBIT_DRIVER', 'mock'],
    ['ANTHROPIC_BASE_URL', 'https://custom-upstream.example/private-route'],
    ['ANTHROPIC_API_KEY', KEY],
  ])(
    'reports the %s environment override without its value and refuses changes',
    async (name, value) => {
      const managed = setup({ env: { [name]: value } });
      const managedState = await managed.service.getSetup();
      expect(managedState.canConfigure).toBe(false);
      expect(managedState.reason).toContain(name);
      expect(managedState.reason).not.toContain(value);
      expect((await managed.json('POST', '/v1/setup', { mode: 'api', apiKey: KEY })).status).toBe(
        409,
      );
      expect(managed.service.vault.has(SETUP_API_KEY)).toBe(false);
    },
  );

  it('refuses changes while any resumable Run or triage call is pending', async () => {
    const s = setup();
    const triage = s.service.triage.call({
      purpose: 'summary',
      botId: null,
      runId: null,
      system: '',
      prompt: 'hello',
    });
    expect((await s.json('POST', '/v1/setup', { mode: 'demo' })).status).toBe(409);
    await triage;
    const bot = s.service.createBot({ name: 'Busy', goal: 'Wait' });
    s.service.orchestrator.enqueue(bot, {});
    expect((await s.service.getSetup()).canConfigure).toBe(false);
    expect((await s.json('POST', '/v1/setup', { mode: 'demo' })).status).toBe(409);
  });

  it('serializes setup and blocks Runs and model calls until the change is complete', async () => {
    let release!: () => void;
    let waiting = true;
    const gate = new Promise<null>((resolve) => {
      release = () => {
        waiting = false;
        resolve(null);
      };
    });
    const s = setup({
      service: { probes: { ...noCli, findClaude: () => (waiting ? gate : Promise.resolve(null)) } },
    });
    const bot = s.service.createBot({ name: 'No racing model call', goal: 'Say hello' });
    const applying = s.service.configureSetup(
      ConfigureSetupBody.parse({ mode: 'api', apiKey: KEY }),
    );
    await expect(
      s.service.configureSetup(ConfigureSetupBody.parse({ mode: 'demo' })),
    ).rejects.toThrow(/in progress/);
    await expect(s.service.startRun(bot.id, {})).rejects.toThrow(/setup is changing/);
    await expect(s.service.proposeBot('Say hello')).rejects.toThrow(/setup is changing/);
    expect(s.service.store.listRuns()).toHaveLength(0);
    release();
    expect((await applying).doctor.driver).toBe('sdk');
  });

  it('never follows linked config files and leaves the target and key vault unchanged', async () => {
    const s = setup();
    const target = join(s.home, 'untouched.json');
    const configFile = join(s.home, 'config.json');
    const original = '{"driver":"mock","important":"preserve me"}';
    writeFileSync(target, original);
    for (const link of [symlinkSync, linkSync]) {
      link(target, configFile);
      expect((await s.json('POST', '/v1/setup', { mode: 'api', apiKey: KEY })).status).toBe(400);
      expect(readFileSync(target, 'utf8')).toBe(original);
      expect(s.service.vault.has(SETUP_API_KEY)).toBe(false);
      rmSync(configFile);
    }
  });

  it('rolls back a new key if another process changes config while readiness is checked', async () => {
    let release!: () => void;
    let waiting = true;
    const gate = new Promise<null>((resolve) => {
      release = () => {
        waiting = false;
        resolve(null);
      };
    });
    const s = setup({
      service: { probes: { ...noCli, findClaude: () => (waiting ? gate : Promise.resolve(null)) } },
    });
    const applying = s.service.configureSetup(
      ConfigureSetupBody.parse({ mode: 'api', apiKey: KEY }),
    );
    const external = '{"driver":"mock","models":{"default":"haiku"}}';
    writeFileSync(join(s.home, 'config.json'), external);
    release();
    await expect(applying).rejects.toThrow(/changed while setup/);
    expect(readFileSync(join(s.home, 'config.json'), 'utf8')).toBe(external);
    expect(s.service.vault.has(SETUP_API_KEY)).toBe(false);
    expect(s.service.config.driver).toBe('mock');
    expect((await s.service.ensureEngine()).handle.driver.kind).toBe('mock');
  });
});
