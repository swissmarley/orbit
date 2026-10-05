/** @jsxRuntime automatic @jsxImportSource react */
import { BotSpec, type BotSpecInput, TriggerSpec } from '@orbit/core/browser';
import { useNavigate } from '@tanstack/react-router';
import { ArrowLeft, ArrowRight, Check, Sparkles } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { PageHeader } from '../components/states';
import { Button } from '../components/ui/button';
import { Card, CardContent } from '../components/ui/card';
import { Field, Input, Select, Textarea } from '../components/ui/input';
import { Switch } from '../components/ui/misc';
import { useActions } from '../lib/actions';
import { cn } from '../lib/cn';
import { prettyJson } from '../lib/diff';
import { useDoctor } from '../lib/queries';
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
    triggers: trigger ? [trigger] : [],
    budgets: {
      maxToolCallsPerRun: d.maxToolCallsPerRun,
      maxWallClockMinutes: d.maxWallClockMinutes,
      maxRunsPerDay: d.maxRunsPerDay,
      maxTokensPerRun: d.maxTokensPerRun.trim() ? Number(d.maxTokensPerRun) : null,
    },
    approvals: { parkWindowSeconds: d.parkWindowSeconds, autoResume: d.autoResume },
    ...(d.fixture ? { mock: { fixture: d.fixture } } : {}),
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
  });
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
      schedule: t ? t.kind : 'manual',
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
      await navigate({ to: '/bots/$botId', params: { botId: bot.id } });
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
                <Button variant="primary" disabled={d.goal.trim().length < 3} onClick={suggest}>
                  <Sparkles aria-hidden /> Suggest a setup
                </Button>
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
