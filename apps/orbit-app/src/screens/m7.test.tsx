/** @jsxRuntime automatic @jsxImportSource react */
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, describe, expect, it } from 'vitest';
import { harness, packTarball } from '@orbit/api/testing';
import { type Mounted, mountApp } from '../test/harness';

/** The repository's reference plugins (jsdom has no file URL to find them from). */
const PLUGINS = [resolve(process.cwd(), 'plugins'), resolve(process.cwd(), '../../plugins')].find(
  (d) => existsSync(resolve(d, 'filesystem', 'orbit-plugin.json')),
);

let m: Mounted | undefined;
afterEach(async () => {
  m?.unmount();
  await m?.h.close();
  m = undefined;
});

async function noA11yViolations(root: Element) {
  const r = await axe.run(root, {
    rules: { 'color-contrast': { enabled: false }, region: { enabled: false } },
  });
  expect(
    r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`),
  ).toEqual([]);
}

const card = (name: string) => {
  const c = screen
    .getAllByTestId('plugin-card')
    .find((el) => within(el).queryByRole('heading', { name }) !== null);
  if (!c) throw new Error(`no card for ${name}`);
  return c;
};

describe('Settings → Integrations', () => {
  it('lists the reference plugins with tiers in words, and enables one after explaining what it gets', async () => {
    const h = harness({ service: { pluginsDir: PLUGINS ?? null } });
    m = mountApp('/settings?tab=integrations', { h });
    await screen.findByRole('heading', { name: 'Filesystem' });
    expect(screen.getAllByTestId('plugin-card')).toHaveLength(5);
    const fs = card('Filesystem');
    expect(within(fs).getByText('off')).toBeTruthy();
    expect(within(fs).getByText(/4 tools: 3 read, 1 external/)).toBeTruthy();
    // Enabling would fail without FS_ROOTS: the card offers "Set up" instead (UI review H3).
    expect(within(fs).queryByRole('button', { name: /^Enable/ })).toBeNull();
    const user = userEvent.setup();
    await user.click(
      within(fs).getByRole('button', { name: /Set up Filesystem: FS_ROOTS missing/ }),
    );
    const roots = within(fs).getByLabelText('FS_ROOTS');
    await waitFor(() => expect(document.activeElement).toBe(roots));
    expect(within(fs).getAllByText('read').length).toBeGreaterThanOrEqual(3);
    await user.type(roots, h.home);
    await user.click(within(fs).getByRole('button', { name: 'Save FS_ROOTS' }));
    await waitFor(() =>
      expect(h.service.plugins.get('filesystem').settings[0]?.value).toBe(h.home),
    );

    await user.click(
      await within(card('Filesystem')).findByRole('button', { name: 'Enable Filesystem' }),
    );
    const dialog = await screen.findByRole('dialog', { name: /Enable Filesystem\?/ });
    expect(dialog.textContent).toMatch(
      /3 reads \(automatic\), 1 external action \(each asks you\)/,
    );
    expect(dialog.textContent).toMatch(/never your API key, your Claude login/);
    await user.click(within(dialog).getByRole('button', { name: /^Enable/ }));
    await waitFor(() => expect(h.service.plugins.get('filesystem').state).toBe('ready'), {
      timeout: 15_000,
    });
    await waitFor(() => expect(within(card('Filesystem')).getByText('on')).toBeTruthy());
    await noA11yViolations(document.body);
  }, 30_000);

  it('stores a plugin secret without ever showing it again', async () => {
    const h = harness({ service: { pluginsDir: PLUGINS ?? null } });
    m = mountApp('/settings?tab=integrations', { h });
    await screen.findByRole('heading', { name: 'GitHub' });
    const gh = card('GitHub');
    const user = userEvent.setup();
    await user.click(within(gh).getByText('Tools, secrets and settings'));
    const input = within(gh).getByLabelText('GITHUB_TOKEN (optional)');
    expect(input.getAttribute('type')).toBe('password');
    await user.type(input, 'ghp_appsecret0123456789abcdefghijklmnop');
    await user.click(within(gh).getByRole('button', { name: 'Store GITHUB_TOKEN' }));
    await waitFor(() => expect(within(card('GitHub')).getByText('set')).toBeTruthy());
    expect(document.body.innerHTML).not.toContain('appsecret');
    expect(h.service.vault.get('plugin_github_GITHUB_TOKEN')).toBe(
      'ghp_appsecret0123456789abcdefghijklmnop',
    );
  });

  it('installs a catalog plugin after showing its integrity, tools and sandbox; removes it', async () => {
    const pkg = packTarball({
      'package/package.json': JSON.stringify({ name: 'orbit-plugin-clock', version: '1.0.0' }),
      'package/orbit-plugin.json': JSON.stringify({
        schemaVersion: 1,
        id: 'clock',
        name: 'Clock',
        version: '1.0.0',
        server: { transport: 'stdio', command: '${node}', args: ['${pluginDir}/server.js'] },
        tools: [{ name: 'get_time', tier: 'READ' }],
        sandbox: { workspace: 'none', network: false },
      }),
      'package/server.js': 'process.stdin.resume();\n',
    });
    const integrity = `sha512-${createHash('sha512').update(pkg).digest('base64')}`;
    const store = mkdtempSync(join(tmpdir(), 'orbit-app-store-'));
    const catalog = {
      schemaVersion: 1,
      plugins: [
        {
          id: 'clock',
          name: 'Clock',
          description: 'What time it is',
          package: 'orbit-plugin-clock',
          version: '1.0.0',
          integrity,
        },
      ],
    };
    // The registry and catalog hosts, answered in-process (jsdom has no network to spare).
    const pluginFetch: typeof fetch = (input) => {
      const url = input instanceof Request ? input.url : input.toString();
      return Promise.resolve(
        url.endsWith('/catalog.json')
          ? new Response(JSON.stringify(catalog))
          : url.endsWith('/orbit-plugin-clock/-/orbit-plugin-clock-1.0.0.tgz')
            ? new Response(new Uint8Array(pkg))
            : new Response('', { status: 404 }),
      );
    };
    try {
      const h = harness({
        config: {
          plugins: {
            catalogUrl: 'https://catalog.example/catalog.json',
            npmRegistry: 'https://registry.example',
            storeDir: store,
          },
        },
        service: { pluginsDir: null, pluginFetch },
      });
      m = mountApp('/settings?tab=integrations', { h });
      const entry = await screen.findByTestId('catalog-entry');
      expect(within(entry).getByText('orbit-plugin-clock@1.0.0')).toBeTruthy();
      const user = userEvent.setup();
      await user.click(within(entry).getByRole('button', { name: 'Install Clock' }));
      const dialog = await screen.findByRole('dialog', { name: /Install Clock\?/ });
      expect(dialog.textContent).toMatch(/matched its integrity \(sha512-/);
      expect(dialog.textContent).toMatch(/1 tool \(1 read\)/);
      expect(dialog.textContent).toMatch(/no workspace · no network/);
      expect(dialog.textContent).toMatch(/stays off until you enable it/);
      await noA11yViolations(document.body);
      await user.click(within(dialog).getByRole('button', { name: /^Install/ }));
      await waitFor(() => expect(h.service.plugins.get('clock').source.kind).toBe('npm'));
      const clock = await waitFor(() => card('Clock'));
      expect(within(clock).getByText('npm orbit-plugin-clock@1.0.0')).toBeTruthy();
      expect(within(clock).getByTestId('plugin-sandbox').textContent).toMatch(
        /OS sandbox|without an OS sandbox/,
      );
      await waitFor(() =>
        expect(within(screen.getByTestId('catalog-entry')).getByText(/installed/)).toBeTruthy(),
      );
      await user.click(within(clock).getByRole('button', { name: 'Remove Clock' }));
      const remove = await screen.findByRole('dialog', { name: /Remove Clock\?/ });
      expect(remove.textContent).toMatch(/deletes its installed files/);
      await user.click(within(remove).getByRole('button', { name: /^Remove/ }));
      await waitFor(() => expect(readdirSync(store)).toEqual([]));
    } finally {
      rmSync(store, { recursive: true, force: true });
    }
  }, 30_000);

  it('shows inbound triggers and mints a webhook signing secret once', async () => {
    const h = harness({ service: { pluginsDir: null } });
    await h.json('POST', '/v1/bots', {
      name: 'Deployer',
      goal: 'Summarize deployments',
      triggers: [{ kind: 'webhook', name: 'deploys' }],
    });
    m = mountApp('/settings?tab=integrations', { h });
    const row = await screen.findByTestId('inbound-row');
    expect(within(row).getByText('needs setup')).toBeTruthy();
    expect(within(row).getByText(/^POST http:\/\/.*\/hooks\/bot_.*\/deploys$/)).toBeTruthy();
    await userEvent
      .setup()
      .click(within(row).getByRole('button', { name: /Create signing secret/ }));
    const secret = await screen.findByTestId('webhook-secret');
    expect(secret.textContent.length).toBeGreaterThanOrEqual(40);
    await waitFor(() =>
      expect(within(screen.getByTestId('inbound-row')).getByText('listening')).toBeTruthy(),
    );
    await noA11yViolations(document.body);
  });
});

describe('Create Bot from a template', () => {
  it('Inbox Triage fills every field (still editable) and creates the scheduled Bot', async () => {
    const h = harness({ service: { pluginsDir: PLUGINS ?? null } });
    m = mountApp('/bots/new', { h });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Use Inbox Triage' }));
    expect((await screen.findByRole<HTMLInputElement>('textbox', { name: 'Name' })).value).toBe(
      'Inbox Triage',
    );
    expect(screen.getByText(/Weekday at 08:00|every weekday at 08:00/i)).toBeTruthy();
    const gmail = screen.getByRole<HTMLInputElement>('checkbox', { name: /Gmail & Calendar/ });
    expect(gmail.checked).toBe(true);
    await user.click(screen.getByRole('button', { name: /Next/ }));
    await user.click(screen.getByRole('button', { name: /Next/ }));
    await user.click(screen.getByRole('button', { name: /Create Bot/ }));
    await waitFor(() => expect(h.service.bots.list()).toHaveLength(1));
    const bot = h.service.bots.list()[0];
    expect(bot?.spec).toMatchObject({
      name: 'Inbox Triage',
      plugins: ['google'],
      triggers: [{ kind: 'cron', cron: '0 8 * * 1-5' }],
      budgets: { maxRunsPerDay: 3 },
    });
  });
});
