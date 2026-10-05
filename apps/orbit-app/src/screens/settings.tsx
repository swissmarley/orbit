/** @jsxRuntime automatic @jsxImportSource react */
import { formatCost, formatTokens, scrubControls } from '@orbit/core/browser';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { Download, KeyRound, LogOut, Octagon, Plus, ShieldCheck, Trash2 } from 'lucide-react';
import { useId, useState } from 'react';
import { confirmAction } from '../components/confirm';
import { EmptyState, ErrorState, ListSkeleton, PageHeader } from '../components/states';
import { Time } from '../components/status';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Field, Input, Select } from '../components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs';
import { useActions } from '../lib/actions';
import { MOD } from '../lib/platform';
import { errorText, useClient } from '../lib/api';
import { helpStore } from '../components/keyboard-help';
import { type AuditRef, auditAction, auditActor, auditRef } from '../lib/audit';
import {
  useAudit,
  useBots,
  useDoctor,
  useKill,
  useRules,
  useSecrets,
  useTriage,
} from '../lib/queries';
import { useStore } from '../lib/store';
import { type ThemeChoice, setTheme, themeStore } from '../lib/theme';
import { Kbd } from '../components/ui/misc';
import { Integrations } from './integrations';

function Row({ term, children }: { term: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-fg-muted">{term}</dt>
      <dd className="min-w-0 break-words text-fg">{children}</dd>
    </>
  );
}

function General() {
  const theme = useStore(themeStore);
  const kill = useKill();
  const actions = useActions();
  const ids = useId();
  const engaged = kill.data?.engaged === true;
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>Appearance</CardTitle>
        </CardHeader>
        <CardContent>
          <Field id={`${ids}-theme`} label="Theme">
            <Select
              id={`${ids}-theme`}
              value={theme}
              onChange={(e) => setTheme(e.target.value as ThemeChoice)}
            >
              <option value="system">Follow the system</option>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </Select>
          </Field>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Global kill switch</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 text-sm">
          <p className="text-fg-muted">
            Stops every Run at once and refuses new ones until released. Enforced by orbitd, not by
            the Bots.
          </p>
          <div>
            <Button
              variant={engaged ? 'secondary' : 'danger'}
              onClick={() =>
                void confirmAction(
                  engaged
                    ? {
                        title: 'Release the kill switch?',
                        body: 'Bots may run again.',
                        confirm: 'Release',
                      }
                    : {
                        title: 'Engage the global kill switch?',
                        body: 'Every Run stops now and nothing new starts until you release it.',
                        confirm: 'Stop everything',
                        danger: true,
                      },
                )
                  .then((ok) => (ok ? actions.setKill(!engaged) : undefined))
                  .catch(() => undefined)
              }
            >
              <Octagon aria-hidden /> {engaged ? 'Release the kill switch' : 'Stop everything'}
            </Button>
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Keyboard</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-fg-muted">
          Press <Kbd>?</Kbd> anywhere for every shortcut, or <Kbd>{MOD}K</Kbd> to search and run
          commands.
          <div className="mt-3">
            <Button onClick={() => helpStore.set(true)}>Show shortcuts</Button>
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Session</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 text-sm">
          <p className="text-fg-muted">
            This browser is signed in with a session cookie from{' '}
            <code className="font-mono">orbit app</code>. Restarting orbitd signs every browser out.
          </p>
          <div>
            <Button onClick={() => void actions.signOut()}>
              <LogOut aria-hidden /> Sign out
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function Engine() {
  const doctor = useDoctor();
  if (doctor.isPending) return <ListSkeleton rows={4} />;
  if (doctor.isError)
    return <ErrorState error={doctor.error} retry={() => void doctor.refetch()} />;
  const d = doctor.data;
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>Auth & driver</CardTitle>
          <Badge tone={d.ok ? 'success' : 'danger'}>{d.ok ? '✔ ready' : '✘ needs attention'}</Badge>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-[9rem_1fr] gap-x-3 gap-y-1 text-sm">
            <Row term="Driver">
              {d.driver ?? 'none'} (
              {d.driverSource === 'forced' ? 'set by ORBIT_DRIVER' : 'chosen automatically'})
            </Row>
            <Row term="Authentication">{d.authLabel}</Row>
            <Row term="Mode">
              {d.mode} · {d.humanPrincipals} human principal{d.humanPrincipals === 1 ? '' : 's'}
            </Row>
            {d.cli ? (
              <Row term="Claude Code CLI">
                {d.cli.version ?? 'unknown version'} ·{' '}
                {d.cli.loggedIn ? 'logged in' : 'not logged in'}
                {d.cli.authMethod ? ` (${d.cli.authMethod})` : ''}
              </Row>
            ) : null}
            <Row term="API credential">{d.apiCredential ?? 'none'}</Row>
            <Row term="Models">
              default <code>{d.models.default}</code> · triage <code>{d.models.triage}</code>
            </Row>
            <Row term="Compliance">
              {d.compliance.allowed ? 'OK' : scrubControls(d.compliance.message ?? 'refused')}
            </Row>
          </dl>
          {d.refusal ? (
            <div
              role="alert"
              className="mt-3 rounded-md bg-danger-bg px-3 py-2 text-sm text-danger"
            >
              <p className="font-medium">{d.refusal.message}</p>
              <p>{d.refusal.hint}</p>
            </div>
          ) : null}
          {d.onboarding ? (
            <div className="mt-3 rounded-md bg-info-bg px-3 py-2 text-sm text-info">
              <p className="font-medium">{d.onboarding.reason}</p>
              <ol className="mt-1 list-decimal pl-5">
                {d.onboarding.steps.map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ol>
            </div>
          ) : null}
          {d.warnings.length > 0 ? (
            <ul className="mt-3 flex flex-col gap-1 text-sm text-warning">
              {d.warnings.map((w) => (
                <li key={w.code}>⚠ {w.message}</li>
              ))}
            </ul>
          ) : null}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Daemon & sandbox</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-[9rem_1fr] gap-x-3 gap-y-1 text-sm">
            <Row term="orbitd">
              {d.daemon.url} · pid {d.daemon.pid}
            </Row>
            <Row term="Up since">
              <Time iso={d.daemon.startedAt} />
            </Row>
            <Row term="Concurrency">
              {d.daemon.concurrency} run{d.daemon.concurrency === 1 ? '' : 's'} at a time
            </Row>
            <Row term="Home">{d.home}</Row>
            <Row term="Engine sandbox">
              {d.sandbox.engineSandbox.available
                ? 'available'
                : `unavailable (missing ${d.sandbox.engineSandbox.missing.join(', ') || '?'})`}
            </Row>
            <Row term="Docker">
              {d.sandbox.docker.available
                ? `available ${d.sandbox.docker.version ?? ''}`
                : 'not available'}
            </Row>
            <Row term="Runtime">
              Node {d.node} · {d.platform}
            </Row>
          </dl>
          <p className="mt-3 text-xs text-fg-subtle">
            Models and the driver come from orbitd's environment (ORBIT_DEFAULT_MODEL,
            ORBIT_TRIAGE_MODEL, ORBIT_DRIVER); change them there and run{' '}
            <code>orbit daemon restart</code>.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

function Policies() {
  const rules = useRules();
  const bots = useBots();
  const actions = useActions();
  const ids = useId();
  const [tool, setTool] = useState('');
  const [effect, setEffect] = useState<'allow' | 'deny'>('deny');
  const [bot, setBot] = useState('');
  const [days, setDays] = useState('7');
  const name = (id: string | null) =>
    id ? scrubControls(bots.data?.find((b) => b.id === id)?.spec.name ?? id) : 'all Bots';
  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>Add a standing rule</CardTitle>
        </CardHeader>
        <CardContent>
          <form
            className="grid items-end gap-3 sm:grid-cols-2 xl:grid-cols-[minmax(12rem,1fr)_8rem_10rem_8rem_auto]"
            onSubmit={(e) => {
              e.preventDefault();
              void actions
                .createRule({
                  toolPattern: tool.trim(),
                  effect,
                  bot: bot || null,
                  expiresAt:
                    days === 'never'
                      ? null
                      : new Date(Date.now() + Number(days) * 86_400_000).toISOString(),
                })
                .then(() => setTool(''))
                .catch(() => undefined);
            }}
          >
            <Field id={`${ids}-tool`} label="Tool">
              <Input
                id={`${ids}-tool`}
                value={tool}
                onChange={(e) => setTool(e.target.value)}
                placeholder="mcp__gmail__send_email or mcp__github__*"
                required
                className="font-mono"
              />
            </Field>
            <Field id={`${ids}-effect`} label="Effect">
              <Select
                id={`${ids}-effect`}
                value={effect}
                onChange={(e) => setEffect(e.target.value as 'allow' | 'deny')}
              >
                <option value="deny">deny</option>
                <option value="allow">allow</option>
              </Select>
            </Field>
            <Field id={`${ids}-bot`} label="For">
              <Select id={`${ids}-bot`} value={bot} onChange={(e) => setBot(e.target.value)}>
                <option value="">all Bots</option>
                {(bots.data ?? []).map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.spec.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field id={`${ids}-exp`} label="Expires">
              <Select id={`${ids}-exp`} value={days} onChange={(e) => setDays(e.target.value)}>
                <option value="1">in 1 day</option>
                <option value="7">in 7 days</option>
                <option value="30">in 30 days</option>
                <option value="never">never</option>
              </Select>
            </Field>
            <Button type="submit" variant="primary" disabled={!tool.trim()}>
              <Plus aria-hidden /> Add
            </Button>
          </form>
          <p className="mt-2 text-xs text-fg-subtle">
            Allow rules never cover financial tools or <code>*</code>, and never auto-allow external
            actions in a run that read untrusted content.
          </p>
        </CardContent>
      </Card>
      {rules.isPending ? (
        <ListSkeleton rows={2} />
      ) : rules.isError ? (
        <ErrorState error={rules.error} />
      ) : rules.data.length === 0 ? (
        <EmptyState icon={<ShieldCheck aria-hidden />} title="No standing rules">
          The default policy decides: reads run, local writes stay in the workspace, external
          actions ask you, financial ones are handed back.
        </EmptyState>
      ) : (
        <Card
          className="overflow-x-auto"
          tabIndex={0}
          role="region"
          aria-label="Standing rules table"
        >
          <table className="w-full text-sm">
            <caption className="sr-only">Standing rules</caption>
            <thead className="border-b border-border text-left text-xs text-fg-muted">
              <tr>
                <th scope="col" className="px-4 py-2 font-medium">
                  Effect
                </th>
                <th scope="col" className="px-4 py-2 font-medium">
                  Tool
                </th>
                <th scope="col" className="px-4 py-2 font-medium">
                  For
                </th>
                <th scope="col" className="px-4 py-2 font-medium">
                  Expires
                </th>
                <th scope="col" className="px-4 py-2 font-medium">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rules.data.map((r) => (
                <tr key={r.id} className="border-b border-border last:border-0">
                  <td className="px-4 py-2">
                    <Badge tone={r.effect === 'allow' ? 'success' : 'danger'}>
                      {r.effect === 'allow' ? '✓ allow' : '✗ deny'}
                    </Badge>
                  </td>
                  <td className="px-4 py-2 font-mono text-xs">{scrubControls(r.toolPattern)}</td>
                  <td className="px-4 py-2 text-fg-muted">{name(r.botId)}</td>
                  <td className="px-4 py-2 text-xs text-fg-muted">
                    {r.expiresAt ? <Time iso={r.expiresAt} /> : 'never'}
                  </td>
                  <td className="px-4 py-2 text-right">
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={`Revoke the rule for ${r.toolPattern}`}
                      onClick={() => void actions.revokeRule(r).catch(() => undefined)}
                    >
                      <Trash2 aria-hidden /> Revoke
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}

/** The triage path's spend: every summary and proposal call, against the daily cap. */
export function TriageUsageCard() {
  const triage = useTriage();
  const doctor = useDoctor();
  const subscription = doctor.data?.authMethod === 'subscription';
  return (
    <Card>
      <CardHeader>
        <CardTitle>Triage model usage</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm">
        <p className="text-fg-muted">
          Post-run summaries (when a Bot's memory is set to “triage”) and Create Bot proposals call{' '}
          <span className="font-mono text-xs">
            {doctor.data?.models.triage ?? 'the triage model'}
          </span>
          {doctor.data?.driver === 'mock'
            ? ' — in demo mode a local, free engine answers instead.'
            : subscription
              ? ' on your Claude subscription — they count toward your usage limits.'
              : doctor.data
                ? ' with your API credentials.'
                : '.'}{' '}
          Orbit never makes these calls without counting them here, and stops at the daily limit (
          <span className="font-mono text-xs">triage.maxCallsPerDay</span>).
        </p>
        {triage.isPending ? (
          <ListSkeleton rows={1} />
        ) : triage.isError ? (
          <ErrorState error={triage.error} />
        ) : (
          <>
            <p className="text-fg" role="status">
              <span className="font-semibold tabular-nums">
                {triage.data.callsToday} of {triage.data.limit}
              </span>{' '}
              calls today · {formatTokens(triage.data.inputTokensToday)} in /{' '}
              {formatTokens(triage.data.outputTokensToday)} out ·{' '}
              {formatCost(triage.data.costUsdToday)}
              {triage.data.limit === 0 ? ' · turned off' : ''}
            </p>
            {triage.data.recent.length > 0 ? (
              <ul className="flex flex-col gap-1 text-xs">
                {triage.data.recent.slice(0, 8).map((c) => (
                  <li key={c.id} className="flex flex-wrap gap-x-2 text-fg-muted">
                    <span className={c.status === 'ok' ? 'text-success' : 'text-danger'}>
                      <span aria-hidden>{c.status === 'ok' ? '✔' : '✘'}</span>{' '}
                      {c.status === 'ok' ? 'ok' : 'failed'}
                    </span>
                    <Time iso={c.createdAt} />
                    <span>{c.purpose === 'summary' ? 'summary' : 'Bot proposal'}</span>
                    <span className="font-mono">{scrubControls(c.model)}</span>
                    <span>
                      {formatTokens(c.inputTokens)}/{formatTokens(c.outputTokens)} tokens
                    </span>
                    {c.runId ? (
                      <Link
                        to="/runs/$runId"
                        params={{ runId: c.runId }}
                        className="text-accent hover:underline"
                      >
                        run …{c.runId.slice(-8)}
                      </Link>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-fg-subtle">No triage calls yet.</p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function Budgets() {
  return (
    <div className="flex flex-col gap-4">
      <BotBudgets />
      <TriageUsageCard />
    </div>
  );
}

function BotBudgets() {
  const bots = useBots();
  if (bots.isPending) return <ListSkeleton rows={3} />;
  if (bots.isError) return <ErrorState error={bots.error} />;
  if (bots.data.length === 0)
    return <EmptyState title="No Bots yet">Budgets are set per Bot.</EmptyState>;
  return (
    <Card className="overflow-x-auto" tabIndex={0} role="region" aria-label="Budgets table">
      <table className="w-full text-sm">
        <caption className="sr-only">Budgets per Bot</caption>
        <thead className="border-b border-border text-left text-xs text-fg-muted">
          <tr>
            {[
              'Bot',
              'Tool calls / run',
              'Minutes / run',
              'Tokens / run',
              '$ / run',
              '$ / day',
              'Runs / day',
            ].map((h) => (
              <th key={h} scope="col" className="px-4 py-2 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {bots.data.map((b) => {
            const x = b.spec.budgets;
            return (
              <tr key={b.id} className="border-b border-border last:border-0">
                <td className="px-4 py-2">
                  <Link
                    to="/bots/$botId"
                    params={{ botId: b.id }}
                    search={{ tab: 'config' }}
                    className="text-accent hover:underline"
                  >
                    {scrubControls(b.spec.name)}
                  </Link>
                </td>
                <td className="px-4 py-2 tabular-nums">{x.maxToolCallsPerRun}</td>
                <td className="px-4 py-2 tabular-nums">{x.maxWallClockMinutes}</td>
                <td className="px-4 py-2 tabular-nums">{x.maxTokensPerRun ?? '—'}</td>
                <td className="px-4 py-2 tabular-nums">{x.maxCostUsdPerRun ?? '—'}</td>
                <td className="px-4 py-2 tabular-nums">{x.maxCostUsdPerDay ?? '—'}</td>
                <td className="px-4 py-2 tabular-nums">{x.maxRunsPerDay}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="px-4 pb-3 text-xs text-fg-subtle">
        Edit a Bot's config to change its budgets (a new version, with undo). A dash (—) means no
        limit.
      </p>
    </Card>
  );
}

function Secrets() {
  const secrets = useSecrets();
  const actions = useActions();
  const ids = useId();
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>Store a secret</CardTitle>
        </CardHeader>
        <CardContent>
          <form
            className="grid items-end gap-3 sm:grid-cols-[14rem_1fr_auto]"
            onSubmit={(e) => {
              e.preventDefault();
              void actions
                .setSecret(name.trim(), value)
                .then(() => {
                  setName('');
                  setValue('');
                })
                .catch(() => undefined);
            }}
          >
            <Field id={`${ids}-n`} label="Name">
              <Input
                id={`${ids}-n`}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="GITHUB_TOKEN"
                required
                className="font-mono"
              />
            </Field>
            <Field id={`${ids}-v`} label="Value">
              <Input
                id={`${ids}-v`}
                type="password"
                autoComplete="off"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                required
              />
            </Field>
            <Button type="submit" variant="primary" disabled={!name.trim() || !value}>
              <KeyRound aria-hidden /> Store
            </Button>
          </form>
          <p className="mt-2 text-xs text-fg-subtle">
            Encrypted in the vault. Values are never shown again, never put in prompts, events or
            logs, and are redacted from tool output.
          </p>
        </CardContent>
      </Card>
      {secrets.isPending ? (
        <ListSkeleton rows={2} />
      ) : secrets.isError ? (
        <ErrorState error={secrets.error} />
      ) : secrets.data.length === 0 ? (
        <EmptyState icon={<KeyRound aria-hidden />} title="No secrets stored" />
      ) : (
        <Card>
          <ul className="divide-y divide-border">
            {secrets.data.map((s) => (
              <li
                key={s.name}
                className="flex items-center justify-between gap-3 px-4 py-2 text-sm"
              >
                <span className="font-mono">{s.name}</span>
                <span className="flex items-center gap-3 text-xs text-fg-muted">
                  updated <Time iso={s.updatedAt} />
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Remove ${s.name}`}
                    onClick={() =>
                      void confirmAction({
                        title: `Remove ${s.name}?`,
                        body: 'Bots that use it lose access. This cannot be undone (the value is not kept).',
                        confirm: 'Remove',
                        danger: true,
                      })
                        .then((ok) => (ok ? actions.removeSecret(s.name) : undefined))
                        .catch(() => undefined)
                    }
                  >
                    <Trash2 aria-hidden /> Remove
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

/** A name with a link where the App has a page for it; the raw id on hover. */
function AuditCell({ refOf }: { refOf: AuditRef | null }) {
  if (!refOf) return null;
  if (!refOf.link) return <span title={refOf.id}>{refOf.text}</span>;
  return (
    <Link {...refOf.link} title={refOf.id} className="text-accent hover:underline">
      {refOf.text}
    </Link>
  );
}

function Audit() {
  const audit = useAudit();
  const bots = useBots();
  const botName = (id: string) => bots.data?.find((b) => b.id === id)?.spec.name;
  const client = useClient();
  const [verify, setVerify] = useState<string | null>(null);
  const check = async () => {
    try {
      const r = await client.audit.verify();
      setVerify(
        r.ok
          ? `✔ Chain intact: ${r.count} records verified.`
          : `✘ Broken at record #${r.firstBadSeq}: ${r.reason}`,
      );
    } catch (err) {
      setVerify(`✘ ${errorText(err)}`);
    }
  };
  const download = async () => {
    const text = await client.audit.export();
    const url = URL.createObjectURL(new Blob([text], { type: 'application/x-ndjson' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `orbit-audit-${new Date().toISOString().slice(0, 10)}.jsonl`;
    a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={() => void check()}>
          <ShieldCheck aria-hidden /> Verify the hash chain
        </Button>
        <Button onClick={() => void download().catch(() => undefined)}>
          <Download aria-hidden /> Export JSONL
        </Button>
        {verify ? (
          <p
            role="status"
            className={verify.startsWith('✔') ? 'text-sm text-success' : 'text-sm text-danger'}
          >
            {verify}
          </p>
        ) : null}
      </div>
      {audit.isPending ? (
        <ListSkeleton rows={4} />
      ) : audit.isError ? (
        <ErrorState error={audit.error} />
      ) : (
        <Card className="overflow-x-auto" tabIndex={0} role="region" aria-label="Audit log table">
          <table className="w-full text-sm">
            <caption className="sr-only">Audit log, newest first</caption>
            <thead className="border-b border-border text-left text-xs text-fg-muted">
              <tr>
                <th scope="col" className="px-4 py-2 font-medium">
                  #
                </th>
                <th scope="col" className="px-4 py-2 font-medium">
                  When
                </th>
                <th scope="col" className="px-4 py-2 font-medium">
                  Action
                </th>
                <th scope="col" className="px-4 py-2 font-medium">
                  Actor
                </th>
                <th scope="col" className="px-4 py-2 font-medium">
                  Subject
                </th>
              </tr>
            </thead>
            <tbody>
              {[...audit.data].reverse().map((r) => (
                <tr key={r.id} className="border-b border-border last:border-0">
                  <td className="px-4 py-1.5 text-xs text-fg-subtle tabular-nums">{r.seq}</td>
                  <td className="px-4 py-1.5 text-xs whitespace-nowrap text-fg-muted">
                    <Time iso={r.ts} />
                  </td>
                  <td className="px-4 py-1.5 text-xs" title={scrubControls(r.action)}>
                    {auditAction(r.action)}
                  </td>
                  <td className="px-4 py-1.5 text-xs">
                    <AuditCell refOf={auditActor(r.actor, botName)} />
                  </td>
                  <td className="px-4 py-1.5 text-xs text-fg-muted">
                    <AuditCell refOf={auditRef(r.subject, botName)} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}

const TABS = [
  'general',
  'engine',
  'integrations',
  'policies',
  'budgets',
  'secrets',
  'audit',
] as const;

export function SettingsScreen() {
  const search: { tab?: string | undefined } = useSearch({ strict: false });
  const navigate = useNavigate();
  const tab =
    search.tab && (TABS as readonly string[]).includes(search.tab) ? search.tab : 'general';
  return (
    <div>
      <PageHeader
        title="Settings"
        description="Engine, integrations, policies, budgets, secrets and the audit log."
      />
      <Tabs
        value={tab}
        onValueChange={(v) => void navigate({ to: '/settings', search: { tab: v }, replace: true })}
      >
        <TabsList aria-label="Settings sections">
          <TabsTrigger value="general">General</TabsTrigger>
          <TabsTrigger value="engine">Auth & engine</TabsTrigger>
          <TabsTrigger value="integrations">Integrations</TabsTrigger>
          <TabsTrigger value="policies">Policies</TabsTrigger>
          <TabsTrigger value="budgets">Budgets</TabsTrigger>
          <TabsTrigger value="secrets">Secrets</TabsTrigger>
          <TabsTrigger value="audit">Audit</TabsTrigger>
        </TabsList>
        <TabsContent value="general">
          <General />
        </TabsContent>
        <TabsContent value="engine">
          <Engine />
        </TabsContent>
        <TabsContent value="integrations">
          <Integrations />
        </TabsContent>
        <TabsContent value="policies">
          <Policies />
        </TabsContent>
        <TabsContent value="budgets">
          <Budgets />
        </TabsContent>
        <TabsContent value="secrets">
          <Secrets />
        </TabsContent>
        <TabsContent value="audit">
          <Audit />
        </TabsContent>
      </Tabs>
      <p className="mt-6 text-xs text-fg-subtle">
        Tip: <Kbd>{MOD}K</Kbd> finds any Bot, run or approval and runs commands.
      </p>
    </div>
  );
}
