/** @jsxRuntime automatic @jsxImportSource react */
import { BotSpec, type Bot, formatLocalTime, scrubControls } from '@orbit/core/browser';
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
import { useBot, useBotVersions, useRules, useRuns, useSchedules } from '../lib/queries';
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
              {s.triggers.map((t, i) => (
                <li key={i} className="flex flex-wrap items-center gap-2">
                  <Badge tone={t.enabled ? 'info' : 'neutral'}>
                    {t.enabled ? '⏰ on' : '○ off'}
                  </Badge>
                  <span className="font-mono text-xs">
                    {t.kind === 'cron'
                      ? `${t.cron}${t.timezone ? ` (${t.timezone})` : ''}`
                      : `every ${t.everyMinutes} min`}
                  </span>
                  {t.name ? <span className="text-fg-muted">· {scrubControls(t.name)}</span> : null}
                </li>
              ))}
              {mine
                .filter((m) => m.nextAt)
                .map((m) => (
                  <li key={m.key} className="text-xs text-fg-muted">
                    {scrubControls(m.description)}: next <Time iso={m.nextAt ?? ''} />
                    {m.lastFiredAt ? (
                      <>
                        {' '}
                        · last <Time iso={m.lastFiredAt} mode="relative" />
                      </>
                    ) : null}
                  </li>
                ))}
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
                  version {v.version} · {formatLocalTime(v.createdAt)}
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
                  version {v.version} · {formatLocalTime(v.createdAt)}
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

const TABS = ['overview', 'runs', 'permissions', 'config'] as const;
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
