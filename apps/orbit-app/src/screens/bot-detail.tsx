/** @jsxRuntime automatic @jsxImportSource react */
import {
  BotSpec,
  type Bot,
  PLUGIN_STATE,
  TRIGGER_KIND_WORD,
  formatWhen,
  scrubControls,
  triggerDetail,
  triggerLabel,
} from '@orbit/core/browser';
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { History, Pencil, Save } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { DiffView } from '../components/diff-view';
import { RunsTable } from '../components/runs-table';
import { RunSparkline } from '../components/sparkline';
import { EmptyState, ErrorState, ListSkeleton, PageHeader } from '../components/states';
import { PausedBadge, StatusBadge, Time } from '../components/status';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Label, Select, Textarea } from '../components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs';
import { useActions } from '../lib/actions';
import { prettyJson, specDiff } from '../lib/diff';
import {
  useBot,
  useBotTaint,
  useBotVersions,
  useBots,
  useMemoryList,
  usePlugins,
  useRules,
  useRuns,
  useSchedules,
} from '../lib/queries';
import { confirmAction } from '../components/confirm';
import { ENGINE_TOOLS } from '../lib/wizard';
import { BotActions } from './bots';

function Def({ term, children }: { term: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-fg-muted">{term}</dt>
      <dd className="min-w-0 text-fg">{children}</dd>
    </>
  );
}

function Overview({ bot }: { bot: Bot }) {
  const plugins = usePlugins();
  const s = bot.spec;
  const schedules = useSchedules();
  const mine = (schedules.data ?? []).filter((x) => x.botId === bot.id);
  const b = s.budgets;
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>Goal</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 text-sm">
          <p className="whitespace-pre-wrap text-fg">{scrubControls(s.goal)}</p>
          {s.instructions ? (
            <details>
              <summary className="cursor-pointer text-fg-muted">Instructions</summary>
              <pre className="mt-2 font-sans whitespace-pre-wrap text-fg">
                {scrubControls(s.instructions)}
              </pre>
            </details>
          ) : null}
          <dl className="grid grid-cols-[8rem_1fr] gap-x-3 gap-y-1">
            <Def term="Model">{s.model ?? 'default (ORBIT_DEFAULT_MODEL)'}</Def>
            <Def term="Max turns">{s.maxTurns ?? 'engine default'}</Def>
            <Def term="Priority">{s.priority}</Def>
            <Def term="Workspace">
              {s.sandbox.kind}
              {s.sandbox.repo ? ` · ${s.sandbox.repo}` : ''} · network {s.sandbox.network}
            </Def>
          </dl>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Triggers</CardTitle>
        </CardHeader>
        <CardContent className="text-sm">
          {s.triggers.length === 0 ? (
            <p className="text-fg-muted">Manual only — runs when you start it.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {s.triggers.map((t, i) => {
                const what = triggerDetail(t);
                // The scheduler describes a trigger by its name, else by its definition.
                const sched = mine.find((m) => m.description === triggerLabel(t));
                return (
                  <li key={i} className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                    <Badge tone={t.enabled ? 'info' : 'neutral'}>
                      <span aria-hidden>{t.enabled ? '●' : '○'}</span>
                      {t.enabled ? 'on' : 'off'}
                    </Badge>
                    {t.name ? <span className="text-fg">{scrubControls(t.name)}</span> : null}
                    <span className="text-xs text-fg-muted">{TRIGGER_KIND_WORD[t.kind]}</span>
                    <span className="font-mono text-xs text-fg-muted">{scrubControls(what)}</span>
                    {sched?.nextAt ? (
                      <span className="text-xs text-fg-muted">
                        · next <Time iso={sched.nextAt} />
                      </span>
                    ) : null}
                    {sched?.lastFiredAt ? (
                      <span className="text-xs text-fg-subtle">
                        · last <Time iso={sched.lastFiredAt} mode="relative" />
                      </span>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Tools</CardTitle>
        </CardHeader>
        <CardContent className="text-sm">
          {s.tools ? (
            <ul className="flex flex-wrap gap-1.5">
              {s.tools.map((t) => (
                <li key={t}>
                  <Badge title={ENGINE_TOOLS.find((x) => x.name === t)?.does}>
                    {t}
                    {ENGINE_TOOLS.find((x) => x.name === t) ? (
                      <span className="text-fg-subtle">
                        {' '}
                        · {ENGINE_TOOLS.find((x) => x.name === t)?.tier}
                      </span>
                    ) : null}
                  </Badge>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-fg-muted">The engine's default set.</p>
          )}
          <p className="mt-3 text-xs text-fg-subtle">
            Every call still goes through the policy: reads run, local writes stay in the workspace,
            external actions ask you, financial ones are handed back.
          </p>
          {s.plugins.length > 0 ? (
            <div className="mt-3">
              <p className="text-xs font-medium text-fg-muted">Plugins</p>
              <ul className="mt-1 flex flex-wrap gap-1.5">
                {s.plugins.map((id) => {
                  const p = plugins.data?.find((x) => x.id === id);
                  const w = p ? PLUGIN_STATE[p.state] : null;
                  return (
                    <li key={id}>
                      <Link to="/settings" search={{ tab: 'integrations' }}>
                        <Badge tone={w?.tone ?? 'warning'} title={w?.meaning ?? 'not installed'}>
                          {p ? scrubControls(p.name) : id}
                          <span aria-hidden>{w ? ` ${w.mark}` : ' ⚠'}</span>
                          <span>{w ? w.label : 'not installed'}</span>
                        </Badge>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : null}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Budgets & approvals</CardTitle>
        </CardHeader>
        <CardContent className="text-sm">
          <dl className="grid grid-cols-[12rem_1fr] gap-x-3 gap-y-1">
            <Def term="Tool calls per run">{b.maxToolCallsPerRun}</Def>
            <Def term="Wall clock per run">{b.maxWallClockMinutes} min</Def>
            <Def term="Tokens per run">{b.maxTokensPerRun ?? 'no limit'}</Def>
            <Def term="Cost per run">
              {b.maxCostUsdPerRun !== null ? `$${b.maxCostUsdPerRun}` : 'no limit'}
            </Def>
            <Def term="Cost per day">
              {b.maxCostUsdPerDay !== null ? `$${b.maxCostUsdPerDay}` : 'no limit'}
            </Def>
            <Def term="Runs per day">{b.maxRunsPerDay}</Def>
            <Def term="Approval wait">{s.approvals.parkWindowSeconds} s, then the run parks</Def>
            <Def term="After decisions">
              {s.approvals.autoResume ? 'resumes automatically' : 'waits for you'}
            </Def>
            <Def term="Approvals expire">after {s.approvals.expireAfterHours} h</Def>
            <Def term="After a usage limit">
              {s.autoResumeAfterUsageLimit ? 'resumes after the reset' : 'stays paused'}
            </Def>
          </dl>
        </CardContent>
      </Card>
    </div>
  );
}

function Permissions({ bot }: { bot: Bot }) {
  const rules = useRules();
  const mine = (rules.data ?? []).filter((r) => r.botId === bot.id || r.botId === null);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Standing rules that apply to this Bot</CardTitle>
        <Link
          to="/settings"
          search={{ tab: 'policies' }}
          className="text-xs text-accent hover:underline"
        >
          Manage rules
        </Link>
      </CardHeader>
      <CardContent>
        {rules.isPending ? (
          <ListSkeleton rows={2} />
        ) : mine.length === 0 ? (
          <p className="text-sm text-fg-muted">
            No standing rules: the default policy decides every call (default deny; external actions
            ask).
          </p>
        ) : (
          <ul className="flex flex-col gap-2 text-sm">
            {mine.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-2">
                <Badge tone={r.effect === 'allow' ? 'success' : 'danger'}>
                  {r.effect === 'allow' ? '✓ allow' : '✗ deny'}
                </Badge>
                <span className="font-mono text-xs">{scrubControls(r.toolPattern)}</span>
                <span className="text-xs text-fg-muted">
                  {r.botId ? 'this Bot' : 'all Bots'}
                  {r.expiresAt ? (
                    <>
                      {' '}
                      · expires <Time iso={r.expiresAt} />
                    </>
                  ) : (
                    ' · no expiry'
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

/** Versioned config: pick two versions to compare; edit saves a new version (with Undo). */
function Config({ bot }: { bot: Bot }) {
  const versions = useBotVersions(bot.id);
  const actions = useActions();
  const list = useMemo(
    () => [...(versions.data ?? [])].sort((a, b) => b.version - a.version),
    [versions.data],
  );
  const [to, setTo] = useState<number | null>(null);
  const [from, setFrom] = useState<number | null>(null);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const toV = list.find((v) => v.version === (to ?? list[0]?.version));
  const fromV = list.find((v) => v.version === (from ?? list[1]?.version ?? list[0]?.version));

  useEffect(() => {
    setTo(null);
    setFrom(null);
  }, [bot.version]);

  const startEdit = () => {
    setText(prettyJson(bot.spec));
    setError(null);
    setEditing(true);
  };
  const save = async () => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      setError(`Not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    const spec = BotSpec.safeParse(parsed);
    if (!spec.success) {
      setError(
        spec.error.issues.map((i) => `${i.path.join('.') || 'spec'}: ${i.message}`).join('; '),
      );
      return;
    }
    try {
      await actions.updateBot(bot, spec.data);
      setEditing(false);
    } catch {
      // toast shown
    }
  };

  if (versions.isPending) return <ListSkeleton rows={3} />;
  if (versions.isError)
    return <ErrorState error={versions.error} retry={() => void versions.refetch()} />;
  if (editing) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Edit configuration (saves version {bot.version + 1})</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <Label htmlFor="spec-editor">Bot spec (JSON)</Label>
          <Textarea
            id="spec-editor"
            value={text}
            onChange={(e) => setText(e.target.value)}
            className="min-h-96 font-mono text-xs"
            spellCheck={false}
            aria-invalid={error !== null}
            aria-describedby={error ? 'spec-error' : undefined}
          />
          {error ? (
            <p id="spec-error" role="alert" className="text-sm text-danger">
              {error}
            </p>
          ) : null}
          {(() => {
            try {
              return (
                <DiffView
                  lines={specDiff(bot.spec, JSON.parse(text))}
                  label={`Changes from version ${bot.version}`}
                  maxHeight="max-h-64"
                />
              );
            } catch {
              return null;
            }
          })()}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
            <Button variant="primary" onClick={() => void save()}>
              <Save aria-hidden /> Save version {bot.version + 1}
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1">
            <Label htmlFor="v-from">Compare</Label>
            <Select
              id="v-from"
              value={fromV?.version ?? ''}
              onChange={(e) => setFrom(Number(e.target.value))}
            >
              {list.map((v) => (
                <option key={v.version} value={v.version}>
                  version {v.version} · {formatWhen(v.createdAt)}
                </option>
              ))}
            </Select>
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="v-to">with</Label>
            <Select
              id="v-to"
              value={toV?.version ?? ''}
              onChange={(e) => setTo(Number(e.target.value))}
            >
              {list.map((v) => (
                <option key={v.version} value={v.version}>
                  version {v.version} · {formatWhen(v.createdAt)}
                </option>
              ))}
            </Select>
          </div>
        </div>
        <Button onClick={startEdit}>
          <Pencil aria-hidden /> Edit config
        </Button>
      </div>
      {fromV && toV ? (
        fromV.version === toV.version ? (
          <Card>
            <CardContent className="pt-4">
              <pre className="overflow-auto font-mono text-xs whitespace-pre-wrap text-fg">
                {scrubControls(prettyJson(toV.spec))}
              </pre>
            </CardContent>
          </Card>
        ) : (
          <DiffView
            lines={specDiff(fromV.spec, toV.spec)}
            label={`version ${fromV.version} → version ${toV.version}`}
          />
        )
      ) : null}
      <Card>
        <CardHeader>
          <CardTitle>
            <History className="mr-1 inline size-4" aria-hidden />
            History
          </CardTitle>
        </CardHeader>
        <CardContent>
          <ol className="flex flex-col gap-1 text-sm">
            {list.map((v) => (
              <li key={v.version} className="flex items-center justify-between">
                <span>
                  version {v.version}
                  {v.version === bot.version ? (
                    <Badge tone="info" className="ml-2">
                      current
                    </Badge>
                  ) : null}
                </span>
                <span className="text-xs text-fg-muted">
                  <Time iso={v.createdAt} />
                </span>
              </li>
            ))}
          </ol>
        </CardContent>
      </Card>
    </div>
  );
}

const SUMMARIZE: Record<Bot['spec']['memory']['summarize'], string> = {
  off: 'off — nothing is remembered after a Run',
  result: "the Run's final answer (free, no model call)",
  triage: 'a summary by the triage model (one metered call per Run, capped per day)',
};

/** Memory settings, workspace taint, subagents and delegation peers. */
function MemoryAndTeam({ bot }: { bot: Bot }) {
  const s = bot.spec;
  const memory = useMemoryList({ bot: bot.id, limit: 500 });
  const taint = useBotTaint(bot.id);
  const bots = useBots();
  const actions = useActions();
  const count = memory.data?.length ?? 0;
  const capped = count >= 500;
  const untrusted = (memory.data ?? []).filter((m) => m.taint.length > 0).length;
  const shown = (n: number) => (memory.isPending ? '…' : `${n}${capped ? '+' : ''}`);
  const subagents = Object.entries(s.subagents);
  const peer = (ref: string) =>
    bots.data?.find((b) => b.id === ref || b.spec.name.toLowerCase() === ref.trim().toLowerCase());
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>Memory</CardTitle>
          <Link
            to="/memory"
            search={{ bot: bot.id }}
            className="text-xs text-accent hover:underline"
          >
            Browse {shown(count)} {count === 1 ? 'memory' : 'memories'}
          </Link>
        </CardHeader>
        <CardContent className="text-sm">
          <dl className="grid grid-cols-[10rem_1fr] gap-x-3 gap-y-1">
            <Def term="After each Run">{SUMMARIZE[s.memory.summarize]}</Def>
            <Def term="Context for new Runs">
              {s.memory.inject
                ? `trusted memories and recent feedback, up to ${s.memory.maxContextChars} characters`
                : 'none'}
            </Def>
            <Def term="Memory tools">{s.memory.tools ? 'search, read and write notes' : 'off'}</Def>
            <Def term="Untrusted">
              {memory.isPending ? (
                '…'
              ) : untrusted === 0 ? (
                'none'
              ) : (
                <span className="text-warning">
                  <span aria-hidden>⚠</span> {shown(untrusted)} — never offered automatically;
                  reading one taints the Run
                </span>
              )}
            </Def>
          </dl>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Workspace files from untrusted Runs</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2 text-sm">
          {taint.isPending ? (
            <ListSkeleton rows={1} />
          ) : !taint.data || taint.data.length === 0 ? (
            <p className="text-fg-muted">
              None. Files written while untrusted content was in a Run would be listed here: a later
              Run that reads one is treated as untrusted too.
            </p>
          ) : (
            <>
              <ul className="flex flex-col gap-1">
                {taint.data.map((f) => (
                  <li key={f.path} className="flex flex-wrap items-center gap-2">
                    <Badge tone="warning">
                      <span aria-hidden>⚠</span> untrusted
                    </Badge>
                    <span className="font-mono text-xs">
                      {f.path === '*' ? 'the whole workspace (a shell ran)' : scrubControls(f.path)}
                    </span>
                    <span className="text-xs text-fg-muted">
                      from {scrubControls(f.sources.join(', '))} ·{' '}
                      <Link
                        to="/runs/$runId"
                        params={{ runId: f.runId }}
                        className="text-accent hover:underline"
                      >
                        run …{f.runId.slice(-8)}
                      </Link>
                    </span>
                  </li>
                ))}
              </ul>
              <div>
                <Button
                  size="sm"
                  onClick={() =>
                    void (async () => {
                      const ok = await confirmAction({
                        title: 'Forget the taint on these files?',
                        body: 'Only after you checked them: later Runs that read them will no longer be treated as untrusted. The audit log records it.',
                        confirm: 'Forget taint',
                      });
                      if (ok) await actions.clearTaint(bot);
                    })().catch(() => undefined)
                  }
                >
                  I checked them — forget the taint
                </Button>
              </div>
            </>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Subagents</CardTitle>
        </CardHeader>
        <CardContent className="text-sm">
          {subagents.length === 0 ? (
            <p className="text-fg-muted">
              None. Subagents take routine sub-tasks inside a Run; their tool calls go through the
              same policy. Add them under{' '}
              <Link
                to="/bots/$botId"
                params={{ botId: bot.id }}
                search={{ tab: 'config' }}
                className="text-accent underline underline-offset-2"
              >
                Config
              </Link>{' '}
              (<span className="font-mono text-xs">subagents</span>).
            </p>
          ) : (
            <ul className="flex flex-col gap-3">
              {subagents.map(([name, a]) => (
                <li key={name}>
                  <p className="font-medium text-fg">
                    {name}
                    {a.model ? (
                      <span className="ml-2 font-mono text-xs text-fg-muted">{a.model}</span>
                    ) : null}
                  </p>
                  <p className="text-fg-muted">{scrubControls(a.description)}</p>
                  <p className="text-xs text-fg-subtle">
                    tools: {a.tools ? a.tools.join(', ') : "the Bot's"}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Delegates to</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2 text-sm">
          {s.delegation.allowedBots.length === 0 ? (
            <p className="text-fg-muted">
              Nobody: this Bot works alone. Add peers under{' '}
              <Link
                to="/bots/$botId"
                params={{ botId: bot.id }}
                search={{ tab: 'config' }}
                className="text-accent underline underline-offset-2"
              >
                Config
              </Link>{' '}
              (<span className="font-mono text-xs">delegation.allowedBots</span>).
            </p>
          ) : (
            <ul className="flex flex-wrap gap-2">
              {s.delegation.allowedBots.map((ref) => {
                const p = peer(ref);
                return (
                  <li key={ref}>
                    {p ? (
                      <Link
                        to="/bots/$botId"
                        params={{ botId: p.id }}
                        className="text-accent hover:underline"
                      >
                        {scrubControls(p.spec.name)}
                      </Link>
                    ) : (
                      <span className="text-fg-muted">
                        {scrubControls(ref)} <span className="text-xs">(no such Bot yet)</span>
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          {s.delegation.allowedBots.length > 0 ? (
            <p className="text-xs text-fg-muted">
              Up to {s.delegation.maxChildrenPerRun} delegations per Run. Each one is a child Run
              with its own approvals, what is left of this Run's budget and its untrusted inputs;
              its answer comes back as untrusted data.
            </p>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}

const TABS = ['overview', 'runs', 'memory', 'permissions', 'config'] as const;
type Tab = (typeof TABS)[number];

export function BotDetailScreen() {
  const params: { botId?: string } = useParams({ strict: false });
  const botId = params.botId ?? '';
  const search: { tab?: string | undefined } = useSearch({ strict: false });
  const navigate = useNavigate();
  const bot = useBot(botId);
  const runs = useRuns({ bot: botId, limit: 100 });
  const tab: Tab = (TABS as readonly string[]).includes(search.tab ?? '')
    ? (search.tab as Tab)
    : 'overview';

  if (bot.isPending) return <ListSkeleton rows={4} />;
  if (bot.isError) return <ErrorState error={bot.error} retry={() => void bot.refetch()} />;
  const b = bot.data;
  const latest = runs.data?.[0];
  return (
    <div>
      <PageHeader
        title={scrubControls(b.spec.name)}
        description={
          <>
            version {b.version} · created <Time iso={b.createdAt} />
          </>
        }
        actions={<BotActions bot={b} />}
      >
        <div className="mt-2 flex flex-wrap items-center gap-3">
          {b.pausedAt ? (
            <PausedBadge />
          ) : latest ? (
            <StatusBadge status={latest.status} />
          ) : (
            <Badge>never run</Badge>
          )}
          <RunSparkline runs={runs.data ?? []} max={30} className="h-6" />
        </div>
      </PageHeader>
      <Tabs
        value={tab}
        onValueChange={(v) =>
          void navigate({
            to: '/bots/$botId',
            params: { botId },
            search: { tab: v },
            replace: true,
          })
        }
      >
        <TabsList aria-label="Bot sections">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="runs">Runs{runs.data ? ` (${runs.data.length})` : ''}</TabsTrigger>
          <TabsTrigger value="memory">Memory & team</TabsTrigger>
          <TabsTrigger value="permissions">Permissions</TabsTrigger>
          <TabsTrigger value="config">Config & versions</TabsTrigger>
        </TabsList>
        <TabsContent value="overview">
          <Overview bot={b} />
        </TabsContent>
        <TabsContent value="runs">
          {runs.isPending ? (
            <ListSkeleton />
          ) : runs.data && runs.data.length > 0 ? (
            <RunsTable runs={runs.data} showBot={false} />
          ) : (
            <EmptyState title="No runs yet">
              Start one with Run, or give the Bot a schedule.
            </EmptyState>
          )}
        </TabsContent>
        <TabsContent value="memory">
          <MemoryAndTeam bot={b} />
        </TabsContent>
        <TabsContent value="permissions">
          <Permissions bot={b} />
        </TabsContent>
        <TabsContent value="config">
          <Config bot={b} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
