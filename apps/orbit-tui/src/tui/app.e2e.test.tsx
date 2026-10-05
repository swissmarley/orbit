import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Daemon, startDaemon } from '@orbit/orbitd';
import { localClient } from '@orbit/sdk-client';
import { afterEach, describe, expect, it } from 'vitest';
import { renderTerminal } from '../../test/render';
import { App } from './app';

const plain = (_style: unknown, text: string) => text;

describe('TUI against a real orbitd (mock driver)', () => {
  let home: string;
  let daemon: Daemon | undefined;
  let unmount: (() => void) | undefined;
  afterEach(async () => {
    unmount?.();
    await daemon?.stop();
    rmSync(home, { recursive: true, force: true });
  });

  it('runs a Bot, shows it park, approves from the TUI and follows it to completion', async () => {
    home = mkdtempSync(join(tmpdir(), 'orbit-tui-e2e-'));
    daemon = await startDaemon({
      env: { ORBIT_HOME: home, ORBIT_DRIVER: 'mock', PATH: process.env.PATH ?? '' },
      port: 0,
      log: () => undefined,
      service: { vaultKeySource: 'file', mock: { delayMs: 0 } },
    });
    const client = localClient(home)!;
    await client.bots.create({
      name: 'Mailer',
      goal: 'Reply to Ada',
      mock: { fixture: 'send-email' },
      approvals: { parkWindowSeconds: 0 },
    });
    const t = renderTerminal(<App client={client} paint={plain} refreshDelayMs={10} />, {
      columns: 120,
      rows: 24,
    });
    unmount = t.unmount;
    await t.waitFor(/Mailer/);
    await t.press('r');
    await t.waitFor(/waiting for your approval/, 10_000);
    await t.waitFor(/Approvals 1 pending/);
    await t.press('3', 'a');
    const done = await t.waitFor(/✔ completed/, 10_000);
    expect(done).toMatch(/resumed after approval/);
    await t.waitFor(/Nothing needs you right now/);
    const [run] = await client.runs.list();
    expect(run?.status).toBe('completed');
  }, 30_000);
});
