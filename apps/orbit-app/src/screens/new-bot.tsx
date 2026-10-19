/** @jsxRuntime automatic @jsxImportSource react */
import {
  BOT_TEMPLATES,
  type BotAvatar,
  type BotTemplate,
  PLUGIN_STATE,
  type BotProposal,
  BotSpec,
  type BotSpecInput,
  type SubagentSpec,
  TriggerSpec,
  avatarFor,
  formatCost,
  formatTokens,
  freeAvatar,
  scrubControls,
} from '@orbit/core/browser';
import { Link, useNavigate } from '@tanstack/react-router';
import { ArrowLeft, ArrowRight, Bot as BotIcon, Check, Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { AvatarPicker } from '../components/avatar';
import { PageHeader } from '../components/states';
import { Button } from '../components/ui/button';
import { Card, CardContent } from '../components/ui/card';
import { Field, Input, Select, Textarea } from '../components/ui/input';
import { Switch } from '../components/ui/misc';
import { useActions } from '../lib/actions';
import { cn } from '../lib/cn';
import { prettyJson } from '../lib/diff';
import { errorText, useClient } from '../lib/api';
import { useBots, useDoctor, usePlugins, useTriage } from '../lib/queries';
import { ENGINE_TOOLS, proposeSpec } from '../lib/wizard';

const STEPS = ['Goal', 'Setup', 'Limits', 'Review'] as const;

interface Draft {
  name: string;
  goal: string;
  instructions: string;
  model: string;
  tools: string[];
  schedule: 'manual' | 'cron' | 'interval';
  cron: string;
  everyMinutes: number;
  maxToolCallsPerRun: number;
  maxWallClockMinutes: number;
  maxRunsPerDay: number;
  maxTokensPerRun: string;
  parkWindowSeconds: number;
  autoResume: boolean;
  fixture: string;
  summarize: 'off' | 'result' | 'triage';
  subagents: Record<string, SubagentSpec>;
  /** Plugin ids the Bot may use (each enabled by the owner in Settings → Integrations). */
  plugins: string[];
  /** How it looks (ADR-020); null until one is picked or suggested. */
  avatar: BotAvatar | null;
}

/** A template as wizard fields: every one of them stays editable. */
export function applyTemplate(d: Draft, t: BotTemplate): Draft {
  const s = t.spec;
  const trigger = s.triggers?.[0];
  return {
    ...d,
    name: s.name,
    goal: s.goal,
    instructions: s.instructions ?? '',
    tools: s.tools ?? [],
    plugins: s.plugins ?? [],
    schedule: trigger?.kind === 'cron' || trigger?.kind === 'interval' ? trigger.kind : 'manual',
    ...(trigger?.kind === 'cron' ? { cron: trigger.cron } : {}),
    ...(trigger?.kind === 'interval' ? { everyMinutes: trigger.everyMinutes } : {}),
    maxToolCallsPerRun: s.budgets?.maxToolCallsPerRun ?? d.maxToolCallsPerRun,
    maxWallClockMinutes: s.budgets?.maxWallClockMinutes ?? d.maxWallClockMinutes,
    maxRunsPerDay: s.budgets?.maxRunsPerDay ?? d.maxRunsPerDay,
    summarize: s.memory?.summarize ?? d.summarize,
    fixture: s.mock?.fixture ?? '',
    // Nothing from an earlier proposal carries over into a template.
    model: s.model ?? '',
    subagents: {},
  };
}

export function draftToSpec(d: Draft): BotSpecInput {
  const trigger =
    d.schedule === 'cron'
      ? { kind: 'cron' as const, cron: d.cron.trim(), enabled: true }
      : d.schedule === 'interval'
        ? { kind: 'interval' as const, everyMinutes: d.everyMinutes, enabled: true }
        : null;
  return {
    name: d.name.trim(),
    goal: d.goal.trim(),
    instructions: d.instructions,
    ...(d.model.trim() ? { model: d.model.trim() } : {}),
    tools: d.tools,
    plugins: d.plugins,
    triggers: trigger ? [trigger] : [],
    budgets: {
      maxToolCallsPerRun: d.maxToolCallsPerRun,
      maxWallClockMinutes: d.maxWallClockMinutes,
      maxRunsPerDay: d.maxRunsPerDay,
      maxTokensPerRun: d.maxTokensPerRun.trim() ? Number(d.maxTokensPerRun) : null,
    },
    approvals: { parkWindowSeconds: d.parkWindowSeconds, autoResume: d.autoResume },
    memory: { summarize: d.summarize },
    ...(Object.keys(d.subagents).length > 0 ? { subagents: d.subagents } : {}),
    ...(d.fixture ? { mock: { fixture: d.fixture } } : {}),
    ...(d.avatar ? { avatar: d.avatar } : {}),
  };
}

/** A triage proposal as wizard fields (the owner's own goal text is kept). */
export function applyProposal(d: Draft, p: BotProposal): Draft {
  // Subagents may only use tools the Bot has.
  const subagents = Object.fromEntries(
    Object.entries(p.subagents).map(([k, v]) => [
      k,
      { ...v, ...(v.tools ? { tools: v.tools.filter((t) => p.tools.includes(t)) } : {}) },
    ]),
  );
  return {
    ...d,
    name: d.name || p.name,
    instructions: p.instructions || d.instructions,
    tools: p.tools,
    schedule: p.schedule ? 'cron' : 'manual',
    ...(p.schedule ? { cron: p.schedule.cron } : {}),
    subagents,
  };
}

/** Create Bot: goal → suggested setup (explained, editable) → limits → review. */
export function NewBotScreen() {
  const ids = useId();
  const navigate = useNavigate();
  const actions = useActions();
  const doctor = useDoctor();
  const mock = doctor.data?.driver === 'mock';
  const [step, setStep] = useState(0);
  const [reasons, setReasons] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [d, setD] = useState<Draft>({
    name: '',
    goal: '',
    instructions: '',
    model: '',
    tools: [],
    schedule: 'manual',
    cron: '0 9 * * 1-5',
    everyMinutes: 60,
    maxToolCallsPerRun: 200,
    maxWallClockMinutes: 60,
    maxRunsPerDay: 50,
    maxTokensPerRun: '',
    parkWindowSeconds: 30,
    autoResume: true,
    fixture: '',
    summarize: 'result',
    subagents: {},
    plugins: [],
    avatar: null,
  });
  const plugins = usePlugins();
  // A face nobody else has yet, until the owner picks one.
  const bots = useBots();
  const [seed] = useState(() => Math.random().toString(36).slice(2));
  useEffect(() => {
    if (bots.data && d.avatar === null) {
      setD((x) => ({ ...x, avatar: freeAvatar(seed, bots.data.map(avatarFor)) }));
    }
  }, [bots.data, d.avatar, seed]);
  const notReady = d.plugins.flatMap((id) => {
    const p = plugins.data?.find((x) => x.id === id);
    return p?.state === 'ready' ? [] : [p ? scrubControls(p.name) : id];
  });
  const client = useClient();
  const triage = useTriage();
  const [asking, setAsking] = useState(false);
  const triageLeft = triage.data ? Math.max(0, triage.data.limit - triage.data.callsToday) : null;
  const subscription = doctor.data?.authMethod === 'subscription';
  /** The metered path: one triage-model call, shown and capped before it is made. */
  const askClaude = async () => {
    setAsking(true);
    try {
      const r = await client.triage.proposeBot(d.goal);
      setD((x) => applyProposal(x, r.proposal));
      setReasons([
        ...r.proposal.rationale,
        `Proposed by ${r.model} · ${formatTokens(r.inputTokens)} in / ${formatTokens(r.outputTokens)} out${r.costUsd !== null ? ` · ${formatCost(r.costUsd)}` : ''} · ${r.usage.callsToday} of ${r.usage.limit} triage calls used today. Review every field.`,
      ]);
      void triage.refetch();
      setStep(1);
    } catch (err) {
      toast.error('Claude could not propose a setup', { description: errorText(err) });
    } finally {
      setAsking(false);
    }
  };
  const stepHeading = useRef<HTMLHeadingElement>(null);
  const firstStep = useRef(true);
  useEffect(() => {
    if (firstStep.current) {
      firstStep.current = false;
      return;
    }
    stepHeading.current?.focus();
  }, [step]);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((x) => ({ ...x, [k]: v }));
  const spec = useMemo(() => draftToSpec(d), [d]);
  const parsed = BotSpec.safeParse(spec);
  const triggerOk = d.schedule === 'manual' || TriggerSpec.safeParse(spec.triggers?.[0]).success;
  const issues = parsed.success
    ? []
    : parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);

  const suggest = () => {
    const p = proposeSpec(d.goal);
    const t = p.spec.triggers?.[0];
    setReasons(p.reasons);
    setD((x) => ({
      ...x,
      name: x.name || p.spec.name,
      tools: p.spec.tools ?? [],
      schedule: t?.kind === 'cron' || t?.kind === 'interval' ? t.kind : 'manual',
      ...(t?.kind === 'cron' ? { cron: t.cron } : {}),
      ...(t?.kind === 'interval' ? { everyMinutes: t.everyMinutes } : {}),
    }));
    setStep(1);
  };

  const create = async () => {
    if (!parsed.success) return;
    setBusy(true);
    try {
      const bot = await actions.createBot(spec);
      // Straight into a chat with the new Bot (ADR-020).
      await navigate({ to: '/chat/$botId', params: { botId: bot.id } });
    } catch {
      // toast shown
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="max-w-3xl">
      <PageHeader
        title="New Bot"
        description="Describe the goal; Orbit suggests a least-privilege setup you can change."
      />
      <ol className="mb-5 flex flex-wrap gap-2" aria-label="Steps">
        {STEPS.map((s, i) => (
          <li
            key={s}
            aria-current={i === step ? 'step' : undefined}
            className={cn(
              'flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium',
              i === step
                ? 'bg-accent text-accent-fg'
                : i < step
                  ? 'bg-accent-subtle text-fg'
                  : 'bg-surface-2 text-fg-muted',
            )}
          >
            <span aria-hidden>{i < step ? '✓' : i + 1}</span> {s}
          </li>
        ))}
      </ol>
      <Card>
        <CardContent className="flex flex-col gap-4 pt-4">
          {/* Focus lands here on every step change (the button that was pressed is gone). */}
          <h2 ref={stepHeading} tabIndex={-1} className="text-sm font-semibold focus:outline-none">
            Step {step + 1} of {STEPS.length}: {STEPS[step]}
          </h2>
          {step === 0 ? (
            <>
              <Field
                id={`${ids}-goal`}
                label="What should this Bot achieve?"
                hint="Plain words. Mention when it should run (e.g. “every weekday at 9”) and what it may touch."
              >
                <Textarea
                  id={`${ids}-goal`}
                  value={d.goal}
                  onChange={(e) => set('goal', e.target.value)}
                  maxLength={4000}
                  className="min-h-28"
                  placeholder="e.g. Summarize new notes in my workspace into a daily digest every weekday at 9"
                  autoFocus
                />
              </Field>
              <div className="flex items-center justify-end gap-3">
                {d.goal.trim().length < 3 ? (
                  <span className="text-xs text-fg-subtle">
                    Describe the goal in a few words first.
                  </span>
                ) : null}
                <Button
                  disabled={d.goal.trim().length < 3 || asking || triageLeft === 0}
                  title={triageLeft === 0 ? 'Daily triage limit reached' : undefined}
                  onClick={() => void askClaude()}
                  aria-describedby={`${ids}-ask-cost`}
                >
                  <BotIcon aria-hidden /> {asking ? 'Asking Claude…' : 'Ask Claude to propose'}
                </Button>
                <Button
                  variant="primary"
                  disabled={d.goal.trim().length < 3 || asking}
                  onClick={suggest}
                >
                  <Sparkles aria-hidden /> Suggest a setup
                </Button>
              </div>
              <p id={`${ids}-ask-cost`} className="text-xs text-fg-muted">
                “Suggest a setup” uses local rules and is free.{' '}
                {mock ? (
                  'Demo mode: “Ask Claude” makes a local, free proposal — no model is called.'
                ) : (
                  <>
                    “Ask Claude” makes one call to{' '}
                    <span className="font-mono">
                      {doctor.data?.models.triage ?? 'the triage model'}
                    </span>
                    {subscription
                      ? ' on your Claude subscription (it counts toward your usage limits).'
                      : ' with your API key.'}
                  </>
                )}{' '}
                {triageLeft === 0
                  ? 'The daily triage limit is used up (it resets at midnight).'
                  : triageLeft !== null && triage.data
                    ? `${triageLeft} of ${triage.data.limit} triage calls left today.`
                    : ''}
              </p>
              <div className="flex flex-col gap-2 border-t border-border pt-3">
                <p className="text-xs font-medium text-fg-muted">Or start from a template</p>
                {BOT_TEMPLATES.map((t) => (
                  <div key={t.id} className="flex flex-wrap items-center gap-2 text-sm">
                    <Button
                      onClick={() => {
                        setD((x) => applyTemplate(x, t));
                        setReasons([t.summary, ...t.setup]);
                        setStep(1);
                      }}
                    >
                      Use {t.title}
                    </Button>
                    <span className="text-xs text-fg-muted">{t.summary}</span>
                  </div>
                ))}
              </div>
            </>
          ) : null}
          {step === 1 ? (
            <>
              {reasons.length > 0 ? (
                <div className="rounded-md bg-accent-subtle px-3 py-2 text-sm">
                  <p className="font-medium text-fg">Suggested from your goal</p>
                  <ul className="mt-1 list-disc pl-5 text-fg-muted">
                    {reasons.map((r) => (
                      <li key={r}>{r}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
              <Field id={`${ids}-name`} label="Name">
                <Input
                  id={`${ids}-name`}
                  value={d.name}
                  onChange={(e) => set('name', e.target.value)}
                  maxLength={80}
                />
              </Field>
              {d.avatar ? (
                <section aria-label="Avatar" className="flex flex-col gap-1">
                  <p className="text-xs font-medium text-fg-muted">Avatar</p>
                  <AvatarPicker value={d.avatar} onChange={(a) => set('avatar', a)} name={d.name} />
                </section>
              ) : null}
              <Field
                id={`${ids}-instr`}
                label="Instructions (optional)"
                hint="How to work: tone, format, what to avoid."
              >
                <Textarea
                  id={`${ids}-instr`}
                  value={d.instructions}
                  onChange={(e) => set('instructions', e.target.value)}
                />
              </Field>
              <fieldset className="flex flex-col gap-2">
                <legend className="mb-1 text-xs font-medium text-fg-muted">Tools</legend>
                <div className="grid gap-2 sm:grid-cols-2">
                  {ENGINE_TOOLS.map((t) => {
                    const on = d.tools.includes(t.name);
                    return (
                      <label
                        key={t.name}
                        className={cn(
                          'flex cursor-pointer items-start gap-2 rounded-md border px-3 py-2 text-sm',
                          on ? 'border-accent bg-accent-subtle' : 'border-border',
                        )}
                      >
                        <input
                          type="checkbox"
                          className="mt-1 accent-[var(--accent)]"
                          checked={on}
                          onChange={() =>
                            set(
                              'tools',
                              on ? d.tools.filter((x) => x !== t.name) : [...d.tools, t.name],
                            )
                          }
                        />
                        <span>
                          <span className="font-medium text-fg">{t.name}</span>{' '}
                          <span className="text-xs text-fg-subtle">· {t.tier}</span>
                          <span className="block text-xs text-fg-muted">{t.does}</span>
                        </span>
                      </label>
                    );
                  })}
                </div>
              </fieldset>
              <fieldset className="flex flex-col gap-2">
                <legend className="mb-1 text-xs font-medium text-fg-muted">Plugins</legend>
                <p className="-mt-1 text-xs text-fg-muted">
                  Each one is enabled and set up in{' '}
                  <Link to="/settings" search={{ tab: 'integrations' }} className="underline">
                    Settings → Integrations
                  </Link>
                  .
                </p>
                {plugins.isPending ? (
                  <p className="text-xs text-fg-muted">Loading plugins…</p>
                ) : plugins.isError ? (
                  <p className="text-xs text-danger">
                    Could not load plugins: {errorText(plugins.error)}
                  </p>
                ) : plugins.data.length > 0 ? (
                  <div className="grid gap-2 sm:grid-cols-2">
                    {plugins.data.map((p) => {
                      const on = d.plugins.includes(p.id);
                      const w = PLUGIN_STATE[p.state];
                      return (
                        <label
                          key={p.id}
                          className={cn(
                            'flex cursor-pointer items-start gap-2 rounded-md border px-3 py-2 text-sm',
                            on ? 'border-accent bg-accent-subtle' : 'border-border',
                          )}
                        >
                          <input
                            type="checkbox"
                            className="mt-1 accent-[var(--accent)]"
                            checked={on}
                            onChange={() =>
                              set(
                                'plugins',
                                on ? d.plugins.filter((x) => x !== p.id) : [...d.plugins, p.id],
                              )
                            }
                          />
                          <span>
                            <span className="font-medium text-fg">{scrubControls(p.name)}</span>{' '}
                            <span className="text-xs text-fg-subtle">
                              · <span aria-hidden>{w.mark}</span> {w.label}
                            </span>
                            <span className="block text-xs text-fg-muted">
                              {p.state === 'ready'
                                ? `${p.tools.length} tools; external ones ask you`
                                : 'Enable it in Settings → Integrations before Runs can use it'}
                            </span>
                          </span>
                        </label>
                      );
                    })}
                  </div>
                ) : (
                  <p className="text-xs text-fg-muted">No plugins known.</p>
                )}
              </fieldset>
              <div className="grid gap-3 sm:grid-cols-[12rem_1fr]">
                <Field id={`${ids}-sched`} label="Runs">
                  <Select
                    id={`${ids}-sched`}
                    value={d.schedule}
                    onChange={(e) => set('schedule', e.target.value as Draft['schedule'])}
                  >
                    <option value="manual">when I start it</option>
                    <option value="cron">on a schedule (cron)</option>
                    <option value="interval">every N minutes</option>
                  </Select>
                </Field>
                {d.schedule === 'cron' ? (
                  <Field
                    id={`${ids}-cron`}
                    label="Cron (local time)"
                    hint="minute hour day month weekday — “0 9 * * 1-5” is 9:00 on weekdays"
                  >
                    <Input
                      id={`${ids}-cron`}
                      value={d.cron}
                      onChange={(e) => set('cron', e.target.value)}
                      className="font-mono"
                    />
                  </Field>
                ) : d.schedule === 'interval' ? (
                  <Field id={`${ids}-every`} label="Every (minutes)">
                    <Input
                      id={`${ids}-every`}
                      type="number"
                      min={1}
                      value={d.everyMinutes}
                      onChange={(e) => set('everyMinutes', Number(e.target.value))}
                    />
                  </Field>
                ) : null}
              </div>
              <Field
                id={`${ids}-model`}
                label="Model (optional)"
                hint="An alias like opus, sonnet or haiku; empty uses ORBIT_DEFAULT_MODEL."
              >
                <Input
                  id={`${ids}-model`}
                  value={d.model}
                  onChange={(e) => set('model', e.target.value)}
                  placeholder={doctor.data?.models.default ?? 'opus'}
                />
              </Field>
              {mock ? (
                <Field
                  id={`${ids}-fixture`}
                  label="Demo scenario (mock driver)"
                  hint="The mock driver replays a recorded run instead of calling Claude."
                >
                  <Select
                    id={`${ids}-fixture`}
                    value={d.fixture}
                    onChange={(e) => set('fixture', e.target.value)}
                  >
                    <option value="">default</option>
                    <option value="send-email">sends an email (asks for approval)</option>
                    <option value="read-then-write-denied">reads, then a write is denied</option>
                    <option value="web-then-send">reads the web, then sends (untrusted)</option>
                    <option value="subagent-delegation">delegates to a subagent</option>
                    <option value="usage-limit">hits a usage limit</option>
                  </Select>
                </Field>
              ) : null}
            </>
          ) : null}
          {step === 2 ? (
            <>
              <p className="text-sm text-fg-muted">
                Limits are enforced by Orbit, not by the prompt: a Run that crosses one stops.
              </p>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field id={`${ids}-calls`} label="Tool calls per run">
                  <Input
                    id={`${ids}-calls`}
                    type="number"
                    min={1}
                    value={d.maxToolCallsPerRun}
                    onChange={(e) => set('maxToolCallsPerRun', Number(e.target.value))}
                  />
                </Field>
                <Field id={`${ids}-wall`} label="Minutes per run">
                  <Input
                    id={`${ids}-wall`}
                    type="number"
                    min={1}
                    max={1440}
                    value={d.maxWallClockMinutes}
                    onChange={(e) => set('maxWallClockMinutes', Number(e.target.value))}
                  />
                </Field>
                <Field
                  id={`${ids}-day`}
                  label="Runs per day"
                  hint="Protects your subscription limits."
                >
                  <Input
                    id={`${ids}-day`}
                    type="number"
                    min={1}
                    value={d.maxRunsPerDay}
                    onChange={(e) => set('maxRunsPerDay', Number(e.target.value))}
                  />
                </Field>
                <Field id={`${ids}-tok`} label="Tokens per run (optional)">
                  <Input
                    id={`${ids}-tok`}
                    type="number"
                    min={1}
                    value={d.maxTokensPerRun}
                    onChange={(e) => set('maxTokensPerRun', e.target.value)}
                    placeholder="no limit"
                  />
                </Field>
                <Field
                  id={`${ids}-park`}
                  label="Wait for a decision (seconds)"
                  hint="Then the run parks and frees its slot until you decide."
                >
                  <Input
                    id={`${ids}-park`}
                    type="number"
                    min={0}
                    max={600}
                    value={d.parkWindowSeconds}
                    onChange={(e) => set('parkWindowSeconds', Number(e.target.value))}
                  />
                </Field>
                <Field
                  id={`${ids}-mem`}
                  label="After each run, remember"
                  hint={
                    d.summarize === 'triage'
                      ? 'One small triage-model call per finished run, counted and capped per day (Settings → Budgets).'
                      : 'Memory is offered to later runs as context, never as instructions.'
                  }
                >
                  <Select
                    id={`${ids}-mem`}
                    value={d.summarize}
                    onChange={(e) => set('summarize', e.target.value as Draft['summarize'])}
                  >
                    <option value="result">Its result (free)</option>
                    <option value="triage">A summary by the triage model (metered)</option>
                    <option value="off">Nothing</option>
                  </Select>
                </Field>
                <div className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2">
                  <label htmlFor={`${ids}-auto`} className="text-sm text-fg">
                    Resume automatically after my decisions
                  </label>
                  <Switch
                    id={`${ids}-auto`}
                    checked={d.autoResume}
                    onCheckedChange={(v) => set('autoResume', v)}
                  />
                </div>
              </div>
            </>
          ) : null}
          {step === 3 ? (
            <>
              <p className="text-sm text-fg-muted">
                This is exactly what will be saved (version 1). You can change it any time; every
                change is a new version.
              </p>
              <pre className="max-h-96 overflow-auto rounded-md bg-surface-2 px-3 py-2 font-mono text-xs text-fg">
                {prettyJson(spec)}
              </pre>
              {notReady.length > 0 ? (
                <p role="note" className="rounded-md bg-warning-bg px-3 py-2 text-sm text-warning">
                  <span aria-hidden>⚠ </span>
                  {notReady.join(', ')} {notReady.length === 1 ? 'is' : 'are'} not on yet: Runs
                  can’t use {notReady.length === 1 ? 'its' : 'their'} tools until you enable{' '}
                  {notReady.length === 1 ? 'it' : 'them'} in Settings → Integrations
                  {mock ? ' (demo mode replays recorded results meanwhile)' : ''}.
                </p>
              ) : null}
            </>
          ) : null}
          {step > 0 && issues.length > 0 ? (
            <ul
              role="alert"
              className="list-disc rounded-md bg-danger-bg py-2 pr-3 pl-7 text-sm text-danger"
            >
              {issues.map((i) => (
                <li key={i}>{i}</li>
              ))}
            </ul>
          ) : null}
          {step > 0 ? (
            <div className="flex justify-between gap-2 border-t border-border pt-3">
              <Button variant="ghost" onClick={() => setStep((s) => s - 1)}>
                <ArrowLeft aria-hidden /> Back
              </Button>
              {step < 3 ? (
                <Button
                  variant="primary"
                  disabled={!parsed.success || !triggerOk}
                  onClick={() => setStep((s) => s + 1)}
                >
                  Next <ArrowRight aria-hidden />
                </Button>
              ) : (
                <Button
                  variant="primary"
                  disabled={!parsed.success || busy}
                  onClick={() => void create()}
                >
                  <Check aria-hidden /> Create Bot
                </Button>
              )}
            </div>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
