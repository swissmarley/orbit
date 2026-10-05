/** @jsxRuntime automatic @jsxImportSource react */
import {
  PLUGIN_STATE,
  type PluginStatus,
  TRIGGER_KIND_WORD,
  TRIGGER_STATE,
  type Tier,
  scrubControls,
} from '@orbit/core/browser';
import type { RouteResponse } from '@orbit/sdk-client/browser';
import { Link } from '@tanstack/react-router';
import { AlertTriangle, KeyRound, Plug, Power, RefreshCw, Webhook } from 'lucide-react';
import { useId, useState } from 'react';
import { confirmAction } from '../components/confirm';
import { EmptyState, ErrorState, ListSkeleton } from '../components/states';
import { TierBadge, Time } from '../components/status';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Field, Input } from '../components/ui/input';
import { useActions } from '../lib/actions';
import { useInboundTriggers, usePlugins } from '../lib/queries';

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
    `It runs in the Bot's workspace with ${gets.length ? gets.join(', ') : 'no secrets'} — never your API key, your Claude login or another plugin's secrets. Everything it returns counts as untrusted.`,
  ].join(' ');
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
    <li className="flex flex-col gap-2 py-2">
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
          {...(s.description ? { hint: t(s.description) } : {})}
          className="min-w-0 flex-1 basis-56"
        >
          <Input
            id={id}
            type="password"
            autoComplete="off"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={s.set ? 'stored — type to replace' : 'not set'}
          />
        </Field>
        <Badge tone={s.set ? 'success' : s.required ? 'attention' : 'neutral'}>
          <span aria-hidden>{s.set ? '✔' : s.required ? '◌' : '○'}</span>
          {s.set ? 'set' : s.required ? 'missing' : 'not set'}
        </Badge>
        <Button type="submit" size="sm" disabled={!value}>
          <KeyRound aria-hidden /> Store
        </Button>
        {s.set ? (
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
        ) : null}
      </form>
    </li>
  );
}

function SettingRow({ plugin, s }: { plugin: PluginStatus; s: PluginStatus['settings'][number] }) {
  const actions = useActions();
  const id = useId();
  const [value, setValue] = useState(s.value ?? '');
  return (
    <li className="py-2">
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
          {...(s.description ? { hint: t(s.description) } : {})}
          className="min-w-0 flex-1 basis-56"
        >
          <Input
            id={id}
            value={value}
            maxLength={2000}
            onChange={(e) => setValue(e.target.value)}
            placeholder={s.default !== null ? `default: ${t(s.default)}` : ''}
            className="font-mono"
          />
        </Field>
        <Button type="submit" size="sm" disabled={value === (s.value ?? '')}>
          Save
        </Button>
      </form>
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
  return (
    <Card data-testid="plugin-card" aria-labelledby={headingId}>
      <CardHeader className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <CardTitle id={headingId}>{t(p.name)}</CardTitle>
            <StateBadge state={p.state} />
            <span className="font-mono text-xs text-fg-muted">
              {p.id} {t(p.version)}
            </span>
            {p.builtIn ? <span className="text-xs text-fg-subtle">ships with Orbit</span> : null}
          </div>
          {p.description ? <p className="text-sm text-fg-muted">{t(p.description)}</p> : null}
        </div>
        <div className="flex flex-wrap gap-2">
          {p.enabled ? (
            <Button size="sm" onClick={disable} disabled={busy}>
              <Power aria-hidden /> Disable
            </Button>
          ) : (
            <Button size="sm" variant="primary" onClick={enable} disabled={busy}>
              <Power aria-hidden /> Enable
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            onClick={() => act(() => actions.checkPlugin(p))}
            disabled={busy}
            aria-label={`Check ${t(p.name)}: start it once and list its tools`}
          >
            <RefreshCw aria-hidden /> Check
          </Button>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {p.warnings.length || p.error ? (
          <div
            role="note"
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
        <section aria-label={`${t(p.name)} tools`}>
          <h4 className="mb-1 text-xs font-medium text-fg-muted">
            Tools — each has a fixed tier; external ones always ask you
          </h4>
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
        <span className="text-fg-muted">{TRIGGER_KIND_WORD[tr.kind]}</span>
        <span className="min-w-0 break-words">{t(tr.description)}</span>
        {tr.path ? <code className="break-all text-xs text-fg-muted">POST {tr.path}</code> : null}
        {tr.detail ? <span className="text-xs text-fg-muted">({t(tr.detail)})</span> : null}
        {tr.kind === 'webhook' && webhookName ? (
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
                  });
                  if (!ok) return;
                }
                setMinted(await actions.mintWebhookSecret(tr.botId, webhookName));
              })().catch(() => undefined)
            }
          >
            <Webhook aria-hidden />{' '}
            {tr.state === 'needs_setup' ? 'Create signing secret' : 'Rotate secret'}
          </Button>
        ) : null}
      </div>
      {minted ? (
        <div
          role="status"
          className="flex flex-col gap-1 rounded-md border border-attention/40 bg-attention-bg px-3 py-2 text-attention"
        >
          <p className="font-medium">
            Copy it now — it is shown once (Orbit keeps it in its vault):
          </p>
          <code className="break-all font-mono text-xs text-fg" data-testid="webhook-secret">
            {minted.secret}
          </code>
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
        <CardTitle>Inbound triggers</CardTitle>
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

function AddPlugin() {
  const actions = useActions();
  const id = useId();
  const [dir, setDir] = useState('');
  return (
    <Card>
      <CardHeader>
        <CardTitle>Add a plugin</CardTitle>
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
            hint="It stays off until you enable it; review its tools and tiers first."
            className="min-w-0 flex-1 basis-64"
          >
            <Input
              id={id}
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
      <InboundTriggers />
      <AddPlugin />
    </div>
  );
}
