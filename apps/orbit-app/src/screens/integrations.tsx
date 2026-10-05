/** @jsxRuntime automatic @jsxImportSource react */
import {
  PLUGIN_SANDBOX_STATE,
  PLUGIN_STATE,
  type PluginInstallPreview,
  type PluginStatus,
  TIER_WORD,
  describeSandboxNeeds,
  TRIGGER_KIND_WORD,
  TRIGGER_STATE,
  type Tier,
  scrubControls,
} from '@orbit/core/browser';
import type { RouteResponse } from '@orbit/sdk-client/browser';
import { Link } from '@tanstack/react-router';
import {
  AlertTriangle,
  Copy,
  Download,
  KeyRound,
  Plug,
  Power,
  RefreshCw,
  Settings2,
  Trash2,
  Webhook,
} from 'lucide-react';
import { useId, useRef, useState } from 'react';
import { toast } from 'sonner';
import { confirmAction } from '../components/confirm';
import { IfRole, RoleGate } from '../components/role-gate';
import { EmptyState, ErrorState, ListSkeleton } from '../components/states';
import { TierBadge, Time } from '../components/status';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Field, Input } from '../components/ui/input';
import { useActions } from '../lib/actions';
import { useInboundTriggers, usePluginCatalog, usePlugins } from '../lib/queries';

/** Manifest text is written by whoever wrote the plugin: shown as text, scrubbed. */
const t = (s: string) => scrubControls(s);

const TIER_ORDER: Tier[] = ['READ', 'WRITE_LOCAL', 'EXTERNAL', 'FINANCIAL'];

/** What enabling a plugin means, in words, before the owner confirms. */
export function enableText(p: PluginStatus): string {
  const count = (tier: Tier) => p.tools.filter((x) => x.tier === tier).length;
  const parts = [
    count('READ') && `${count('READ')} read${count('READ') === 1 ? '' : 's'} (automatic)`,
    count('WRITE_LOCAL') &&
      `${count('WRITE_LOCAL')} local write${count('WRITE_LOCAL') === 1 ? '' : 's'} (drafts, automatic)`,
    count('EXTERNAL') &&
      `${count('EXTERNAL')} external action${count('EXTERNAL') === 1 ? '' : 's'} (each asks you)`,
    count('FINANCIAL') && `${count('FINANCIAL')} financial (never executed)`,
  ].filter(Boolean);
  const gets = [
    p.secrets.length ? `its own secrets (${p.secrets.map((s) => s.name).join(', ')})` : null,
    p.settings.length ? `its settings` : null,
    p.env.length ? `the variables ${p.env.join(', ')}` : null,
  ].filter(Boolean);
  return [
    `Orbit starts it once to list its tools (${t(p.server)}). Bots whose config lists "${p.id}" can then use: ${parts.join(', ') || 'no tools'}.`,
    `It gets ${gets.length ? gets.join(', ') : 'no secrets'} — never your API key, your Claude login or another plugin's secrets. Everything it returns counts as untrusted.`,
    sandboxText(p),
  ].join(' ');
}

/** How the plugin runs here (ADR-019), in a sentence. */
export function sandboxText(p: PluginStatus): string {
  const s = p.sandbox;
  switch (s.state) {
    case 'sandboxed':
      return `It runs in an OS sandbox (${s.engine ?? 'sandbox'}) with ${describeSandboxNeeds(s.needs)}; your home folder and Orbit's data are not there.`;
    case 'unsandboxed':
      return `It runs as your user without an OS sandbox: ${t(s.reason ?? 'none is available')}.`;
    case 'refused':
      return `It cannot start here: ${t(s.reason ?? 'it cannot be sandboxed')} and plugins.sandbox is required.`;
    case 'off':
      return 'It runs as your user: plugins.sandbox is off.';
    case 'remote':
      return 'It is a server elsewhere: nothing runs on this computer.';
  }
}

/** What installing a package means, in words, before the owner confirms. */
export function installText(pv: PluginInstallPreview): string {
  const count = (tier: Tier) => pv.tools.filter((x) => x.tier === tier).length;
  const tools = TIER_ORDER.flatMap((tier) =>
    count(tier) ? [`${count(tier)} ${TIER_WORD[tier].label}`] : [],
  );
  return [
    `${t(pv.package)}@${t(pv.packageVersion)} matched its integrity (${pv.integrity.slice(0, 23)}…)${pv.fromCatalog ? ' and the catalog’s manifest' : ''}.`,
    `It declares ${pv.tools.length} tool${pv.tools.length === 1 ? '' : 's'} (${tools.join(', ')})${pv.secrets.length ? `, the secrets ${pv.secrets.map((s) => s.name).join(', ')}` : ''}, and a sandbox with ${describeSandboxNeeds(pv.sandbox)}.`,
    'Nothing in the package runs now; it stays off until you enable it.',
  ].join(' ');
}

function SandboxBadge({ plugin: p }: { plugin: PluginStatus }) {
  const w = PLUGIN_SANDBOX_STATE[p.sandbox.state];
  return (
    <Badge tone={w.tone} title={w.meaning}>
      <span aria-hidden>{w.mark}</span>
      {w.label}
    </Badge>
  );
}

/** "12 tools: 7 read, 1 local write, 4 external". */
export function toolSummary(p: PluginStatus): string {
  const parts = TIER_ORDER.flatMap((tier) => {
    const n = p.tools.filter((x) => x.tier === tier).length;
    return n ? [`${n} ${TIER_WORD[tier].label}`] : [];
  });
  return `${p.tools.length} tool${p.tools.length === 1 ? '' : 's'}: ${parts.join(', ')}`;
}

/** Required secrets or settings that are still missing (enabling would fail). */
export function missingSetup(p: PluginStatus): string[] {
  return [
    ...p.secrets.filter((s) => s.required && !s.set).map((s) => s.name),
    ...p.settings
      .filter((s) => s.required && s.value === null && s.default === null)
      .map((s) => s.name),
  ];
}

async function copy(text: string, what: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(`Copied the ${what}`);
  } catch {
    toast.error(`Could not copy the ${what}`, { description: 'Select it and copy it by hand.' });
  }
}

function StateBadge({ state }: { state: PluginStatus['state'] }) {
  const w = PLUGIN_STATE[state];
  return (
    <Badge tone={w.tone} title={w.meaning}>
      <span aria-hidden>{w.mark}</span>
      {w.label}
    </Badge>
  );
}

function SecretRow({ plugin, s }: { plugin: PluginStatus; s: PluginStatus['secrets'][number] }) {
  const actions = useActions();
  const id = useId();
  const [value, setValue] = useState('');
  return (
    <li className="flex flex-col gap-1 py-2">
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void actions
            .setPluginSecret(plugin, s.name, value)
            .then(() => setValue(''))
            .catch(() => undefined);
        }}
      >
        <Field
          id={id}
          label={`${s.name}${s.required ? '' : ' (optional)'}`}
          className="min-w-0 flex-1 basis-56"
        >
          <Input
            id={id}
            {...(s.description ? { 'aria-describedby': `${id}-hint` } : {})}
            data-field={s.name}
            type="password"
            autoComplete="off"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={s.set ? 'stored — type to replace' : 'not set'}
          />
        </Field>
        <Badge
          tone={s.set ? 'success' : s.required ? 'attention' : 'neutral'}
          className="mb-1.5 min-w-20 justify-center"
        >
          <span aria-hidden>{s.set ? '✔' : s.required ? '◌' : '○'}</span>
          {s.set ? 'set' : s.required ? 'missing' : 'not set'}
        </Badge>
        <RoleGate route="setPluginSecret">
          <Button type="submit" size="sm" disabled={!value} aria-label={`Store ${s.name}`}>
            <KeyRound aria-hidden /> Store
          </Button>
        </RoleGate>
        {s.set ? (
          <RoleGate route="removePluginSecret">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              aria-label={`Remove ${s.name} from ${plugin.name}`}
              onClick={() =>
                void confirmAction({
                  title: `Remove ${s.name}?`,
                  body: `${plugin.name} loses it; Runs that need it fail until you store it again.`,
                  confirm: 'Remove',
                  danger: true,
                })
                  .then((ok) => (ok ? actions.removePluginSecret(plugin, s.name) : undefined))
                  .catch(() => undefined)
              }
            >
              Remove
            </Button>
          </RoleGate>
        ) : null}
      </form>
      {s.description ? (
        <p id={`${id}-hint`} className="text-xs text-fg-subtle">
          {t(s.description)}
        </p>
      ) : null}
    </li>
  );
}

function SettingRow({ plugin, s }: { plugin: PluginStatus; s: PluginStatus['settings'][number] }) {
  const actions = useActions();
  const id = useId();
  const [value, setValue] = useState(s.value ?? '');
  return (
    <li className="flex flex-col gap-1 py-2">
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void actions
            .setPluginSetting(plugin, s.name, value.trim() || null)
            .catch(() => undefined);
        }}
      >
        <Field
          id={id}
          label={`${s.name}${s.required ? '' : ' (optional)'}`}
          className="min-w-0 flex-1 basis-56"
        >
          <Input
            id={id}
            {...(s.description ? { 'aria-describedby': `${id}-hint` } : {})}
            data-field={s.name}
            value={value}
            maxLength={2000}
            onChange={(e) => setValue(e.target.value)}
            placeholder={s.default !== null ? `default: ${t(s.default)}` : ''}
            className="font-mono"
          />
        </Field>
        <RoleGate route="setPluginSetting">
          <Button
            type="submit"
            size="sm"
            disabled={value === (s.value ?? '')}
            aria-label={`Save ${s.name}`}
          >
            Save
          </Button>
        </RoleGate>
      </form>
      {s.description ? (
        <p id={`${id}-hint`} className="text-xs text-fg-subtle">
          {t(s.description)}
        </p>
      ) : null}
    </li>
  );
}

function PluginCard({ plugin: p }: { plugin: PluginStatus }) {
  const actions = useActions();
  const [busy, setBusy] = useState(false);
  const headingId = useId();
  const act = (fn: () => Promise<unknown>) => {
    setBusy(true);
    void fn()
      .catch(() => undefined)
      .finally(() => setBusy(false));
  };
  const enable = () =>
    act(async () => {
      const ok = await confirmAction({
        title: `Enable ${t(p.name)}?`,
        body: enableText(p),
        confirm: 'Enable',
      });
      if (ok) await actions.setPluginEnabled(p, true);
    });
  const disable = () =>
    act(async () => {
      const ok = await confirmAction({
        title: `Disable ${t(p.name)}?`,
        body: 'No Bot can use its tools until you enable it again. Its secrets stay in the vault.',
        confirm: 'Disable',
      });
      if (ok) await actions.setPluginEnabled(p, false);
    });
  const sorted = [...p.tools].sort(
    (a, b) =>
      TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier) || a.name.localeCompare(b.name),
  );
  const missing = missingSetup(p);
  const noteId = `${headingId}-note`;
  // Details stay open for plugins in use; the rest stay short (UI review M2).
  const [open, setOpen] = useState(p.enabled);
  const body = useRef<HTMLDivElement>(null);
  const setUp = () => {
    setOpen(true);
    // Focus the first missing field once the details are open.
    requestAnimationFrame(() => {
      const field = missing[0];
      const el = field
        ? body.current?.querySelector<HTMLInputElement>(`[data-field="${field}"]`)
        : null;
      el?.focus();
    });
  };
  return (
    <Card data-testid="plugin-card" role="group" aria-labelledby={headingId}>
      <CardHeader className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <CardTitle id={headingId}>{t(p.name)}</CardTitle>
            <StateBadge state={p.state} />
            <SandboxBadge plugin={p} />
            <span className="font-mono text-xs text-fg-muted">
              {p.id} {t(p.version)}
            </span>
            {p.builtIn ? <span className="text-xs text-fg-subtle">ships with Orbit</span> : null}
            {p.source.kind === 'npm' ? (
              <span className="font-mono text-xs text-fg-subtle">
                npm {t(p.source.package ?? '')}@{t(p.source.version ?? '')}
              </span>
            ) : null}
          </div>
          {p.description ? <p className="text-sm text-fg-muted">{t(p.description)}</p> : null}
        </div>
        <div className="flex flex-wrap gap-2">
          {p.enabled ? (
            <RoleGate route="disablePlugin">
              <Button
                size="sm"
                onClick={disable}
                disabled={busy}
                aria-label={`Disable ${t(p.name)}`}
              >
                <Power aria-hidden /> Disable
              </Button>
            </RoleGate>
          ) : missing.length > 0 ? (
            // Enabling would fail until the required secrets and settings exist (UI review H3).
            <RoleGate route="setPluginSecret">
              <Button
                size="sm"
                onClick={setUp}
                aria-label={`Set up ${t(p.name)}: ${missing.join(', ')} missing`}
                aria-describedby={noteId}
              >
                <Settings2 aria-hidden /> Set up
              </Button>
            </RoleGate>
          ) : (
            <RoleGate route="enablePlugin">
              <Button
                size="sm"
                variant="primary"
                onClick={enable}
                disabled={busy}
                aria-label={`Enable ${t(p.name)}`}
              >
                <Power aria-hidden /> Enable
              </Button>
            </RoleGate>
          )}
          <RoleGate route="checkPlugin">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => act(() => actions.checkPlugin(p))}
              disabled={busy || missing.length > 0}
              aria-label={`Check ${t(p.name)}: start it once and list its tools`}
            >
              <RefreshCw aria-hidden /> Check
            </Button>
          </RoleGate>
          {p.builtIn ? null : (
            <RoleGate route="removePlugin">
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                aria-label={`Remove ${t(p.name)}`}
                onClick={() =>
                  act(async () => {
                    const ok = await confirmAction({
                      title: `Remove ${t(p.name)}?`,
                      body:
                        p.source.kind === 'npm'
                          ? 'Orbit forgets it, deletes its installed files and its secrets.'
                          : 'Orbit forgets it and its secrets; its folder stays where it is.',
                      confirm: 'Remove',
                      danger: true,
                    });
                    if (ok) await actions.removePlugin(p);
                  })
                }
              >
                <Trash2 aria-hidden /> Remove
              </Button>
            </RoleGate>
          )}
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {p.warnings.length || p.error ? (
          <div
            role="note"
            id={noteId}
            className="flex flex-col gap-1 rounded-md border border-warning/40 bg-warning-bg px-3 py-2 text-sm text-warning"
          >
            {p.error ? (
              <p className="text-danger">
                <span aria-hidden>✘ </span>
                {t(p.error)}
              </p>
            ) : null}
            {p.warnings.map((w) => (
              <p key={w}>
                <AlertTriangle aria-hidden className="mr-1 inline size-4" />
                {t(w)}
              </p>
            ))}
          </div>
        ) : null}
        <p className="text-sm text-fg-muted">
          {toolSummary(p)} · each tool has a fixed tier; external ones always ask you
        </p>
        <p className="text-xs text-fg-muted" data-testid="plugin-sandbox">
          {sandboxText(p)}
        </p>
        <details open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
          <summary className="cursor-pointer text-sm font-medium text-fg">
            {missing.length > 0 ? 'Set up and review its tools' : 'Tools, secrets and settings'}
          </summary>
          <div ref={body} className="mt-3 flex flex-col gap-4">
            <section aria-label={`${t(p.name)} tools`}>
              <ul className="flex flex-col gap-1 text-sm">
                {sorted.map((tool) => (
                  <li key={tool.name} className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                    <TierBadge tier={tool.tier} />
                    <span className="font-mono text-xs">{tool.name}</span>
                    {tool.egress ? (
                      <span
                        className="text-xs text-fg-muted"
                        title="Bot-chosen addresses: asks you once untrusted content is in the Run"
                      >
                        · reaches any address
                      </span>
                    ) : null}
                    {tool.available === false ? (
                      <span className="text-xs text-danger">· not offered by the server</span>
                    ) : null}
                    {tool.description ? (
                      <span className="text-xs text-fg-muted">{t(tool.description)}</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </section>
            {p.secrets.length ? (
              <section aria-label={`${t(p.name)} secrets`}>
                <h4 className="text-xs font-medium text-fg-muted">
                  Secrets — stored in the vault, only this plugin receives them
                </h4>
                <ul className="divide-y divide-border">
                  {p.secrets.map((s) => (
                    <SecretRow key={s.name} plugin={p} s={s} />
                  ))}
                </ul>
              </section>
            ) : null}
            {p.settings.length ? (
              <section aria-label={`${t(p.name)} settings`}>
                <h4 className="text-xs font-medium text-fg-muted">Settings</h4>
                <ul className="divide-y divide-border">
                  {p.settings.map((s) => (
                    <SettingRow key={s.name} plugin={p} s={s} />
                  ))}
                </ul>
              </section>
            ) : null}
          </div>
        </details>
        <p className="text-xs text-fg-muted">
          {p.bots.length ? (
            <>
              Used by{' '}
              {p.bots.map((b, i) => (
                <span key={b.id}>
                  {i > 0 ? ', ' : ''}
                  <Link to="/bots/$botId" params={{ botId: b.id }} className="underline">
                    {t(b.name)}
                  </Link>
                </span>
              ))}
              .
            </>
          ) : (
            <>No Bot lists it yet: add “{p.id}” to a Bot’s plugins.</>
          )}
          {p.checkedAt ? (
            <>
              {' '}
              Last checked <Time iso={p.checkedAt} />.
            </>
          ) : null}
        </p>
      </CardContent>
    </Card>
  );
}

type Inbound = RouteResponse<'listTriggers'>[number];

function InboundRow({ trigger: tr }: { trigger: Inbound }) {
  const actions = useActions();
  const [minted, setMinted] = useState<RouteResponse<'webhookSecret'> | null>(null);
  const w = TRIGGER_STATE[tr.state];
  const webhookName = tr.path?.split('/').at(-1) ?? null;
  const copyButton = useRef<HTMLButtonElement>(null);
  // Hosted: the public address. Locally the App is served by orbitd, so its
  // origin is the address senders use (through a tunnel).
  const origin = typeof window === 'undefined' ? '' : window.location.origin;
  const address = tr.url ?? (tr.path ? `${origin}${tr.path}` : null);
  return (
    <li className="flex flex-col gap-2 py-2 text-sm" data-testid="inbound-row">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Badge tone={w.tone} title={w.meaning}>
          <span aria-hidden>{w.mark}</span>
          {w.label}
        </Badge>
        <Link to="/bots/$botId" params={{ botId: tr.botId }} className="font-medium underline">
          {t(tr.botName)}
        </Link>
        <span className="text-fg-muted">· {TRIGGER_KIND_WORD[tr.kind]} ·</span>
        <span className="min-w-0 break-words">{t(tr.description)}</span>
        {tr.detail ? <span className="text-xs text-fg-muted">({t(tr.detail)})</span> : null}
        {tr.kind === 'webhook' && webhookName ? (
          <RoleGate route="webhookSecret">
            <Button
              size="sm"
              className="ml-auto"
              onClick={() =>
                void (async () => {
                  if (tr.state !== 'needs_setup') {
                    const ok = await confirmAction({
                      title: 'Rotate the signing secret?',
                      body: 'The old secret stops working at once; update the sender with the new one.',
                      confirm: 'Rotate',
                      danger: true,
                    });
                    if (!ok) return;
                  }
                  setMinted(await actions.mintWebhookSecret(tr.botId, webhookName));
                  requestAnimationFrame(() => copyButton.current?.focus());
                })().catch(() => undefined)
              }
            >
              <Webhook aria-hidden />{' '}
              {tr.state === 'needs_setup' ? 'Create signing secret' : 'Rotate secret'}
            </Button>
          </RoleGate>
        ) : null}
      </div>
      {address ? (
        <div className="flex flex-wrap items-center gap-2">
          <code className="break-all text-xs text-fg-muted">POST {address}</code>
          <Button
            size="sm"
            variant="ghost"
            aria-label={`Copy the webhook address of ${t(tr.description)}`}
            onClick={() => void copy(address, 'webhook address')}
          >
            <Copy aria-hidden /> Copy
          </Button>
        </div>
      ) : null}
      {minted ? (
        <div
          role="status"
          className="flex flex-col gap-1 rounded-md border border-attention/40 bg-attention-bg px-3 py-2 text-attention"
        >
          <p className="font-medium">
            Copy it now — it is shown once (Orbit keeps it in its vault):
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <code className="break-all font-mono text-xs text-fg" data-testid="webhook-secret">
              {minted.secret}
            </code>
            <Button
              ref={copyButton}
              size="sm"
              aria-label="Copy the signing secret"
              onClick={() => void copy(minted.secret, 'signing secret')}
            >
              <Copy aria-hidden /> Copy
            </Button>
          </div>
          <p className="text-xs">
            {minted.style === 'github'
              ? 'Set it as the GitHub webhook secret. GitHub signs with X-Hub-Signature-256.'
              : 'Send X-Orbit-Timestamp (unix seconds) and X-Orbit-Signature: sha256= HMAC-SHA256 of "<timestamp>.<body>".'}{' '}
            orbitd listens on loopback only: forward a tunnel to it for senders on other machines.
          </p>
          <Button size="sm" variant="ghost" className="self-start" onClick={() => setMinted(null)}>
            Done
          </Button>
        </div>
      ) : null}
    </li>
  );
}

function InboundTriggers() {
  const q = useInboundTriggers();
  return (
    <Card>
      <CardHeader>
        <h2 className="text-base font-semibold text-fg">Inbound triggers</h2>
      </CardHeader>
      <CardContent>
        <p className="mb-2 text-xs text-fg-muted">
          Webhooks, Slack messages, file and git changes start Runs. What they deliver is untrusted:
          such Runs start tainted, so external actions always ask you.
        </p>
        {q.isPending ? (
          <ListSkeleton rows={2} />
        ) : q.isError ? (
          <ErrorState error={q.error} retry={() => void q.refetch()} />
        ) : q.data.length === 0 ? (
          <p className="text-sm text-fg-muted">
            None yet. Add a webhook, Slack, file or git trigger to a Bot’s triggers.
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {q.data.map((tr) => (
              <InboundRow key={tr.key} trigger={tr} />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * The plugin catalog (ADR-019). Reading it is a request to its host, so it
 * is fetched only when the owner asks ("Browse catalog"), never by opening
 * the tab.
 */
function InstallFromCatalog() {
  const [browsing, setBrowsing] = useState(false);
  const q = usePluginCatalog(browsing);
  const actions = useActions();
  const [busy, setBusy] = useState<string | null>(null);
  const install = (id: string) => {
    setBusy(id);
    void (async () => {
      // orbitd downloads and verifies it first; nothing is kept until the owner says yes.
      const preview = await actions.previewPluginInstall(id);
      const ok = await confirmAction({
        title: `Install ${t(preview.name)}?`,
        body: installText(preview),
        confirm: 'Install',
      });
      if (ok) await actions.installPlugin(id);
    })()
      .catch(() => undefined)
      .finally(() => setBusy(null));
  };
  return (
    <Card>
      <CardHeader>
        <h2 className="text-base font-semibold text-fg">Install from catalog</h2>
      </CardHeader>
      <CardContent>
        {!browsing && q.data === undefined ? (
          <div className="flex flex-wrap items-center gap-3">
            <p className="min-w-0 flex-1 basis-64 text-sm text-fg-muted">
              Plugins vetted for Orbit, each pinned to an exact version. Orbit asks the catalog’s
              host (plugins.catalogUrl) only when you browse it.
            </p>
            <Button onClick={() => setBrowsing(true)}>
              <Download aria-hidden /> Browse catalog
            </Button>
          </div>
        ) : q.isPending ? (
          <ListSkeleton rows={2} />
        ) : q.isError ? (
          <ErrorState error={q.error} retry={() => void q.refetch()} />
        ) : q.data.error ? (
          <div role="note" className="flex flex-col items-start gap-2 text-sm text-warning">
            <p>
              <AlertTriangle aria-hidden className="mr-1 inline size-4" />
              {t(q.data.error)}
            </p>
            <p className="text-fg-muted">
              Check the network, or set plugins.catalogUrl to a catalog you can reach.
            </p>
            <Button size="sm" onClick={() => void q.refetch()} disabled={q.isFetching}>
              <RefreshCw aria-hidden /> {q.isFetching ? 'Retrying…' : 'Retry'}
            </Button>
          </div>
        ) : q.data.entries.length === 0 ? (
          <p className="text-sm text-fg-muted">
            The catalog lists no plugins yet. A package you trust can be installed from a terminal:{' '}
            <code className="font-mono text-xs">
              orbit plugin install npm:&lt;package&gt;@&lt;version&gt; --integrity sha512-…
            </code>
          </p>
        ) : (
          <ul className="divide-y divide-border" aria-label="Catalog plugins">
            {q.data.entries.map((e) => (
              <li
                key={e.id}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm"
                data-testid="catalog-entry"
              >
                <span className="font-medium">{t(e.name)}</span>
                <span className="font-mono text-xs text-fg-muted">
                  {t(e.package)}@{t(e.version)}
                </span>
                {e.description ? (
                  <span className="basis-full text-xs text-fg-muted">{t(e.description)}</span>
                ) : null}
                {e.installed ? (
                  <Badge tone="success" className="ml-auto">
                    <span aria-hidden>✔</span>
                    installed{e.installedVersion ? ` ${t(e.installedVersion)}` : ''}
                  </Badge>
                ) : (
                  <Button
                    size="sm"
                    className="ml-auto"
                    disabled={busy !== null}
                    aria-label={`Install ${t(e.name)}`}
                    onClick={() => install(e.id)}
                  >
                    <Download aria-hidden /> {busy === e.id ? 'Checking…' : 'Install'}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
        <p className="mt-2 text-xs text-fg-subtle">
          Each entry pins an exact version and its sha512 integrity; Orbit verifies both before it
          unpacks anything, never runs install scripts, and keeps it off until you enable it.
        </p>
      </CardContent>
    </Card>
  );
}

function AddPlugin() {
  const actions = useActions();
  const id = useId();
  const [dir, setDir] = useState('');
  return (
    <Card>
      <CardHeader>
        <h2 className="text-base font-semibold text-fg">Add a plugin</h2>
      </CardHeader>
      <CardContent>
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void actions
              .addPlugin(dir.trim())
              .then(() => setDir(''))
              .catch(() => undefined);
          }}
        >
          <Field
            id={id}
            label="Folder with an orbit-plugin.json"
            className="min-w-0 flex-1 basis-64"
          >
            <Input
              id={id}
              aria-describedby={`${id}-hint`}
              value={dir}
              onChange={(e) => setDir(e.target.value)}
              placeholder="/home/me/orbit-plugins/linear"
              className="font-mono"
            />
          </Field>
          <Button type="submit" disabled={!dir.trim()}>
            <Plug aria-hidden /> Add
          </Button>
        </form>
        <p id={`${id}-hint`} className="mt-1 text-xs text-fg-subtle">
          It stays off until you enable it; review its tools and tiers first.
        </p>
      </CardContent>
    </Card>
  );
}

export function Integrations() {
  const plugins = usePlugins();
  return (
    <div className="flex flex-col gap-4">
      <h2 className="text-base font-semibold text-fg">Plugins</h2>
      <p className="-mt-2 text-sm text-fg-muted">
        Plugins are MCP servers Orbit runs for your Bots. Every tool has a fixed tier, Orbit’s own
        policy decides each call, and a plugin only ever receives its own secrets.
      </p>
      {plugins.isPending ? (
        <ListSkeleton rows={3} />
      ) : plugins.isError ? (
        <ErrorState error={plugins.error} retry={() => void plugins.refetch()} />
      ) : plugins.data.length === 0 ? (
        <EmptyState icon={<Plug aria-hidden />} title="No plugins known" />
      ) : (
        <div className="flex flex-col gap-4">
          {plugins.data.map((p) => (
            <PluginCard key={p.id} plugin={p} />
          ))}
        </div>
      )}
      <IfRole route="installPlugin">
        <InstallFromCatalog />
      </IfRole>
      <InboundTriggers />
      <IfRole route="addPlugin">
        <AddPlugin />
      </IfRole>
    </div>
  );
}
