/** @jsxRuntime automatic @jsxImportSource react */
import { OidcSignIn } from '@orbit/api';
import { type Harness, harness } from '@orbit/api/testing';
import { type PrincipalRole, event } from '@orbit/core/browser';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, describe, expect, it } from 'vitest';
import { paletteStore } from '../components/palette';
import { takeoverStore } from '../components/takeover';
import { importMemoryIntent } from '../lib/intents';
import { type Mounted, mountApp } from '../test/harness';

/**
 * Hosted roles in the App (ADR-015, UI review H2): what a viewer, an operator
 * and the owner may use. Local mode (the owner) looks exactly as before.
 */

let m: Mounted | undefined;
afterEach(async () => {
  m?.unmount();
  await m?.h.close();
  m = undefined;
  // Stores outlive a mounted App: start each test with every dialog closed.
  paletteStore.set(false);
  takeoverStore.set(null);
  importMemoryIntent.set(false);
});

async function noA11yViolations(root: Element) {
  // WCAG 2.1 AA, as the e2e suite checks (contrast is checked there, in real browsers).
  const r = await axe.run(root, {
    runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa'] },
    rules: { 'color-contrast': { enabled: false } },
  });
  expect(
    r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`),
  ).toEqual([]);
}

const gated = (el: HTMLElement) => el.getAttribute('aria-disabled') === 'true';

/** A Run paused when orbitd stopped, waiting for someone to resume or stop it. */
async function pausedRun(h: Harness): Promise<string> {
  await h.json('POST', '/v1/bots', { name: 'Mailer', goal: 'g', mock: { fixture: 'pong' } });
  const queued = h.service.orchestrator.enqueue('mailer');
  h.service.store.append(queued.runId, queued.botId, [
    event('run.started', {
      driver: 'mock',
      authMethod: 'mock',
      model: null,
      cwd: h.home,
      resumeSessionId: null,
    }),
    event('run.paused', {
      reason: 'interrupted',
      by: 'system',
      sessionId: 's1',
      interruptedTurn: true,
      toolUseId: 't9',
      toolName: 'Read',
      detail: 'Read (t9) has no result',
    }),
  ]);
  return queued.runId;
}

async function runView(role: PrincipalRole | undefined) {
  const h = harness();
  const runId = await pausedRun(h);
  m = mountApp(`/runs/${runId}`, { h, ...(role ? { role } : {}) });
  const resume = await screen.findByRole('button', { name: /Resume run/ });
  return { h, runId, resume };
}

describe('Run view by role', () => {
  it('a viewer watches: Run and Bot controls say which role they need; no Take over', async () => {
    const { h, runId, resume } = await runView('viewer');
    expect(gated(resume)).toBe(true);
    expect(resume.textContent).toMatch(/needs the operator role/);
    const stop = screen.getByRole('button', { name: /^Stop/ });
    expect(gated(stop)).toBe(true);
    const pauseBot = await screen.findByRole('button', { name: /Pause Bot/ });
    expect(pauseBot.textContent).toMatch(/needs the owner role/);
    expect(screen.queryByRole('button', { name: /Take over/ })).toBeNull();
    const user = userEvent.setup();
    await user.click(resume);
    expect(h.service.store.getRun(runId)?.status).toBe('paused');
    await user.keyboard('P');
    expect(await screen.findByText('Needs the operator role to pause a Run')).toBeTruthy();
    await noA11yViolations(document.body);
  });

  it('an operator controls the Run, not the Bot', async () => {
    const { resume } = await runView('operator');
    expect(gated(resume)).toBe(false);
    expect(gated(screen.getByRole('button', { name: /^Stop/ }))).toBe(false);
    expect(gated(await screen.findByRole('button', { name: /Pause Bot/ }))).toBe(true);
    expect(screen.queryByRole('button', { name: /Take over/ })).toBeNull();
  });

  it('the owner (local mode) sees every control as before', async () => {
    const { h, runId, resume } = await runView(undefined);
    expect(await screen.findByRole('button', { name: 'Take over Mailer' })).toBeTruthy();
    expect(document.querySelector('[data-needs-role]')).toBeNull();
    // One order: the Run's controls, then the Bot's.
    const names = within(resume.parentElement!)
      .getAllByRole('button')
      .map((b) => b.textContent.trim());
    expect(names).toEqual(['Resume run', 'Stop', 'Pause Bot', 'Take over']);
    await userEvent.setup().click(resume);
    await waitFor(() => expect(h.service.store.getRun(runId)?.status).not.toBe('paused'));
  });
});

/** A parked Run of the send-email scenario: one EXTERNAL approval pending. */
async function inbox(role: PrincipalRole) {
  const h = harness();
  await h.json('POST', '/v1/bots', {
    name: 'Mailer',
    goal: 'Reply to Ada',
    mock: { fixture: 'send-email' },
    approvals: { parkWindowSeconds: 0 },
  });
  await h.json('POST', '/v1/bots/mailer/runs', {});
  await h.service.queue.idle();
  const [approval] = h.service.approvals.list({ status: 'pending' });
  if (!approval) throw new Error('no pending approval');
  m = mountApp('/inbox', { h, role });
  await screen.findByTestId('inbox-row');
  return { h, approval };
}

describe('Approvals by role', () => {
  it('a viewer reads the whole card but cannot decide, by button or key', async () => {
    const { h, approval } = await inbox('viewer');
    const user = userEvent.setup();
    await user.keyboard('a');
    const card = await screen.findByTestId('approval-card');
    for (const name of [/^Approve/, /^Deny/, /^Edit/, /^Always allow/]) {
      expect(gated(within(card).getByRole('button', { name }))).toBe(true);
    }
    await user.keyboard('a');
    expect(await screen.findByText('Needs the operator role to approve or deny')).toBeTruthy();
    await user.keyboard('d');
    expect(screen.queryByRole('textbox', { name: /reason/i })).toBeNull();
    expect(h.service.approvals.require(approval.id).status).toBe('pending');
    await noA11yViolations(document.body);
  });

  it('an operator approves, but "Always allow" needs the owner', async () => {
    const { h, approval } = await inbox('operator');
    const user = userEvent.setup();
    await user.keyboard('a');
    const card = await screen.findByTestId('approval-card');
    expect(gated(within(card).getByRole('button', { name: /^Approve/ }))).toBe(false);
    expect(gated(within(card).getByRole('button', { name: /^Always allow/ }))).toBe(true);
    await user.keyboard('A');
    expect(await screen.findByText('Needs the owner role to always allow a tool')).toBeTruthy();
    await user.keyboard('a');
    await waitFor(() => expect(h.service.approvals.require(approval.id).status).toBe('approved'));
  });
});

describe('Settings, Memory, Integrations and the palette by role', () => {
  it('a viewer has no Audit or Secrets tab and cannot use the kill switch', async () => {
    const h = harness();
    m = mountApp('/settings?tab=audit', { h, role: 'viewer' });
    const tabs = await screen.findByRole('tablist', { name: 'Settings sections' });
    expect(within(tabs).queryByRole('tab', { name: 'Audit' })).toBeNull();
    expect(within(tabs).queryByRole('tab', { name: 'Secrets' })).toBeNull();
    // ?tab=audit falls back to General.
    const kill = await screen.findByRole('button', { name: /Stop everything/ });
    expect(gated(kill)).toBe(true);
    expect(kill.textContent).toMatch(/needs the owner role/);
  });

  it('the owner keeps every tab', async () => {
    m = mountApp('/settings?tab=general');
    const tabs = await screen.findByRole('tablist', { name: 'Settings sections' });
    expect(within(tabs).getByRole('tab', { name: 'Audit' })).toBeTruthy();
    expect(within(tabs).getByRole('tab', { name: 'Secrets' })).toBeTruthy();
    expect(gated(await screen.findByRole('button', { name: /Stop everything/ }))).toBe(false);
  });

  it('an operator reads memories but cannot import, export, add, edit or delete them', async () => {
    const h = harness();
    await h.json('POST', '/v1/bots', { name: 'Notes', goal: 'g' });
    await h.json('POST', '/v1/bots/notes/memory', { title: 'Launch owner', body: 'Ada.' });
    m = mountApp('/memory', { h, role: 'operator' });
    await screen.findByRole('region', { name: 'Selected memory' });
    for (const name of [/Export all/, /Import…/, /Add memory/, /^Edit/, /^Delete/]) {
      expect(gated(screen.getByRole('button', { name }))).toBe(true);
    }
  });

  it('an operator sees plugins but no install or add, and cannot enable one', async () => {
    const h = harness({ service: { pluginsDir: null } });
    m = mountApp('/settings?tab=integrations', { h, role: 'operator' });
    await screen.findByRole('heading', { name: 'Inbound triggers' });
    expect(screen.queryByRole('heading', { name: 'Install from catalog' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Add a plugin' })).toBeNull();
  });

  it("the palette offers a viewer neither the kill switch nor the owner's commands", async () => {
    const h = harness();
    await h.json('POST', '/v1/bots', { name: 'Notes', goal: 'g' });
    m = mountApp('/inbox', { h, role: 'viewer' });
    await screen.findByRole('heading', { name: 'Needs you' });
    const user = userEvent.setup();
    await user.keyboard('{Control>}k{/Control}');
    const palette = await screen.findByRole('dialog', { name: 'Command palette' });
    await within(palette).findByText('Notes');
    expect(within(palette).queryByText(/Kill switch/)).toBeNull();
    expect(within(palette).queryByText(/Import memories/)).toBeNull();
    expect(within(palette).queryByText(/Take over/)).toBeNull();
    expect(within(palette).queryByText(/Run Notes now/)).toBeNull();
  });
});

describe('Keyboard paths (UI review M5)', () => {
  it('P pauses the running Run in the Run view', async () => {
    const h = harness({ service: { mock: { delayMs: 60 } } });
    await h.json('POST', '/v1/bots', {
      name: 'Reader',
      goal: 'Read the notes',
      mock: { fixture: 'many-reads' },
    });
    const run = (await h.json<{ runId: string }>('POST', '/v1/bots/reader/runs', {})).body;
    m = mountApp(`/runs/${run.runId}`, { h });
    await screen.findByRole('button', { name: /Pause run/ });
    await userEvent.setup().keyboard('P');
    await waitFor(() => expect(h.service.store.getRun(run.runId)?.status).toBe('paused'), {
      timeout: 5000,
    });
  }, 15_000);

  it('the palette opens "Take over <Bot>…" and "Import memories…"', async () => {
    const h = harness();
    await h.json('POST', '/v1/bots', { name: 'Notes', goal: 'g' });
    m = mountApp('/inbox', { h });
    await screen.findByRole('heading', { name: 'Needs you' });
    const user = userEvent.setup();
    await user.keyboard('{Control>}k{/Control}');
    let palette = await screen.findByRole('dialog', { name: 'Command palette' });
    await user.click(await within(palette).findByText('Take over Notes…'));
    const dialog = await screen.findByRole('dialog', { name: 'Take over Notes' });
    expect(within(dialog).getByTestId('takeover-command').textContent).toBe('orbit shell notes');
    await user.keyboard('{Escape}');
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Take over Notes' })).toBeNull(),
    );

    await user.keyboard('{Control>}k{/Control}');
    palette = await screen.findByRole('dialog', { name: 'Command palette' });
    await user.click(await within(palette).findByText('Import memories…'));
    expect(await screen.findByRole('dialog', { name: 'Import memories' })).toBeTruthy();
  });
});

describe('Hosted take-over (UI review M6)', () => {
  it('says it is done on the Orbit server by whoever runs it', async () => {
    const PUBLIC = 'https://orbit.example.com';
    const oidc = new OidcSignIn({
      issuer: 'https://id.example.com',
      clientId: 'orbit',
      clientSecret: () => null,
      scopes: ['openid'],
      redirectUri: `${PUBLIC}/v1/auth/oidc/callback`,
      principals: () => [],
    });
    const h = harness({
      config: {
        mode: 'hosted' as const,
        principals: [
          { id: 'ada', kind: 'human' as const, name: 'Ada', oidc: { subject: 'sub-ada' } },
        ],
        hosted: {
          publicUrl: PUBLIC,
          oidc: { issuer: 'https://id.example.com', clientId: 'orbit' },
        },
      },
      app: { hosted: { publicUrl: PUBLIC, oidc, tls: false } },
    });
    await h.json('POST', '/v1/bots', { name: 'Notes', goal: 'g' });
    m = mountApp('/bots/notes', { h });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Take over Notes' }));
    const dialog = await screen.findByRole('dialog', { name: 'Take over Notes' });
    expect(within(dialog).getByTestId('takeover-hosted').textContent).toMatch(
      /done on the Orbit server.*bearer token/,
    );
    expect(dialog.textContent).toMatch(/a terminal on the Orbit server/);
  });
});

describe('Plugin catalog failures (UI review M7)', () => {
  it('an unreachable catalog says what to check and retries', async () => {
    let calls = 0;
    const h = harness({
      config: { plugins: { catalogUrl: 'https://catalog.example/catalog.json' } },
      service: {
        pluginsDir: null,
        pluginFetch: () => {
          calls += 1;
          return Promise.resolve(new Response('', { status: 503 }));
        },
      },
    });
    m = mountApp('/settings?tab=integrations', { h });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /Browse catalog/ }));
    expect(await screen.findByText(/set plugins\.catalogUrl/)).toBeTruthy();
    const before = calls;
    expect(before).toBeGreaterThan(0);
    await user.click(screen.getByRole('button', { name: /Retry/ }));
    await waitFor(() => expect(calls).toBeGreaterThan(before));
  });
});
