/** @jsxRuntime automatic @jsxImportSource react */
import type { DoctorReport, RouteResponse } from '@orbit/sdk-client/browser';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ArrowRight, Check, KeyRound, Play, RefreshCw, Terminal } from 'lucide-react';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { ErrorState, ListSkeleton } from './states';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { Field, Input, Select } from './ui/input';
import { errorText, useClient } from '../lib/api';
import { cn } from '../lib/cn';
import { keys } from '../lib/queries';
import { useRole } from '../lib/role';

type Mode = 'api' | 'demo' | 'cli';
type Step = 'engine' | 'connect' | 'ready';
const SETUP_KEY = ['orbit', 'setup'] as const;
const STEPS: readonly { id: Step; label: string }[] = [
  { id: 'engine', label: 'Engine' },
  { id: 'connect', label: 'Connect' },
  { id: 'ready', label: 'Ready' },
];
const ENGINES = [
  {
    mode: 'api',
    title: 'Anthropic API',
    description: 'Connect an API key for real Claude replies. Usage is billed to your API account.',
    icon: KeyRound,
  },
  {
    mode: 'demo',
    title: 'Try the demo',
    description: 'Explore recorded replies and approvals. No account, credentials, or charges.',
    icon: Play,
  },
  {
    mode: 'cli',
    title: 'Existing Claude Code login',
    description: 'Use Claude Code already signed in on this computer. Local, personal use only.',
    icon: Terminal,
  },
] as const;

function currentMode(doctor: DoctorReport): Mode {
  return doctor.driver === 'cli' ? 'cli' : doctor.driver === 'sdk' ? 'api' : 'demo';
}

/** One setup flow shared by first run and Settings. Credentials never enter browser storage. */
export function EngineSetup({ onReady }: { onReady?: (doctor: DoctorReport) => void }) {
  const client = useClient();
  const qc = useQueryClient();
  const role = useRole();
  const owner = role.atLeast('owner');
  const setup = useQuery({
    queryKey: SETUP_KEY,
    queryFn: () => client.call('getSetup'),
    enabled: owner,
    retry: false,
  });
  const [mode, setMode] = useState<Mode>('api');
  const [model, setModel] = useState('sonnet');
  const [step, setStep] = useState<Step>('engine');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [forgetKey, setForgetKey] = useState(false);
  const [saved, setSaved] = useState<RouteResponse<'getSetup'> | null>(null);
  const [applied, setApplied] = useState(false);
  const initialized = useRef(false);
  const mounted = useRef(true);
  const password = useRef<HTMLInputElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const ids = useId();

  useLayoutEffect(() => {
    heading.current?.focus();
  }, [step]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (password.current) password.current.value = '';
    };
  }, []);

  useEffect(() => {
    if (!setup.data || initialized.current) return;
    initialized.current = true;
    const d = setup.data.doctor;
    // A fresh demo install starts with the real API option; connecting is always explicit.
    if (d.driver === 'sdk' || d.driver === 'cli') {
      setMode(currentMode(d));
      setModel(d.models.default);
    }
  }, [setup.data]);

  const changeStep = (next: Step) => {
    if (password.current) password.current.value = '';
    setError(null);
    setCopied(false);
    setStep(next);
  };
  const choose = (next: Mode) => {
    if (password.current) password.current.value = '';
    setError(null);
    setForgetKey(false);
    setMode(next);
  };
  const copyLogin = async () => {
    try {
      await navigator.clipboard.writeText('claude auth login');
      if (mounted.current) setCopied(true);
    } catch {
      if (mounted.current) setError('Copy is unavailable. Select and copy the command above.');
    }
  };

  if (!owner) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Connect Orbit</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-fg-muted">
          An Orbit owner connects the engine and manages credentials. You can keep using the Bots
          available to your account.
        </CardContent>
      </Card>
    );
  }
  if (setup.isPending) return <ListSkeleton rows={4} />;
  if (setup.isError) return <ErrorState error={setup.error} retry={() => void setup.refetch()} />;
  const data = setup.data;
  const hasKey =
    data.apiKeyStored ||
    data.doctor.apiCredential === 'api_key' ||
    data.doctor.apiCredential === 'api_key_helper';

  const save = async () => {
    if (busy || !data.canConfigure) return;
    const apiKey = password.current?.value.trim() ?? '';
    // Clear the DOM before sending, including failed requests. It is never query data.
    if (password.current) password.current.value = '';
    if (mode === 'api' && !apiKey && !hasKey) {
      setError('Enter your Anthropic API key, or choose the demo to explore without one.');
      return;
    }
    if (mode !== 'demo' && !model.trim()) {
      setError('Choose a model before continuing.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await client.call('configureSetup', {
        body: {
          mode,
          model: model.trim() || 'sonnet',
          ...(apiKey ? { apiKey } : {}),
          ...(mode === 'demo' && forgetKey ? { forgetApiKey: true } : {}),
        },
      });
      qc.setQueryData(SETUP_KEY, result);
      qc.setQueryData(keys.doctor, result.doctor);
      if (!mounted.current) return;
      setSaved(result);
      setApplied(true);
      changeStep('ready');
      onReady?.(result.doctor);
    } catch (err) {
      const message = errorText(err);
      if (mounted.current) setError(apiKey ? message.replaceAll(apiKey, '[redacted]') : message);
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  const d = saved?.doctor ?? data.doctor;
  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Connect Orbit</CardTitle>
          <p className="mt-1 max-w-prose text-sm text-fg-muted">
            Choose how your Bots think. You can change this later in Settings → Engine.
          </p>
        </div>
        {data.doctor.driver === 'mock' && step !== 'ready' ? <Badge>Demo mode</Badge> : null}
      </CardHeader>
      <CardContent className="flex flex-col gap-5 pt-5">
        <ol aria-label="Setup progress" className="flex flex-wrap gap-x-6 gap-y-2 text-xs">
          {STEPS.map((item, index) => (
            <li
              key={item.id}
              aria-current={step === item.id ? 'step' : undefined}
              className={cn(
                'flex items-center gap-2 text-fg-subtle',
                step === item.id && 'text-accent',
              )}
            >
              <span className="flex size-5 items-center justify-center rounded-full border border-current font-medium tabular-nums">
                {index + 1}
              </span>
              <span className={step === item.id ? 'font-medium' : undefined}>{item.label}</span>
            </li>
          ))}
        </ol>

        {!data.canConfigure ? (
          <div className="rounded-md bg-warning-bg p-3 text-sm" role="status">
            <p>{data.reason ?? 'Setup is currently managed outside this App.'}</p>
            <Button className="mt-2" size="sm" onClick={() => void setup.refetch()}>
              <RefreshCw aria-hidden /> Check again
            </Button>
          </div>
        ) : null}

        {step === 'engine' ? (
          <div className="flex flex-col gap-4">
            <h2 ref={heading} tabIndex={-1} className="text-base font-semibold outline-none">
              How would you like to start?
            </h2>
            {data.doctor.driver === 'mock' ? (
              <p className="text-sm text-fg-muted">
                Demo mode is active. Connect a real engine when you are ready.
              </p>
            ) : null}
            <fieldset disabled={busy || !data.canConfigure} className="flex flex-col gap-2">
              <legend className="sr-only">Choose an engine</legend>
              {ENGINES.map(({ mode: choice, title, description, icon: Icon }) => (
                <label
                  key={choice}
                  className={cn(
                    'flex cursor-pointer items-start gap-3 rounded-md border border-border px-3 py-3 transition-colors hover:bg-surface-2',
                    mode === choice && 'border-accent bg-accent-subtle',
                  )}
                >
                  <input
                    type="radio"
                    name={`${ids}-engine`}
                    value={choice}
                    checked={mode === choice}
                    onChange={() => choose(choice)}
                    className="mt-1 accent-accent"
                  />
                  <Icon className="mt-0.5 size-4 shrink-0 text-fg-muted" aria-hidden />
                  <span className="min-w-0">
                    <span className="flex flex-wrap items-center gap-2 text-sm font-medium">
                      {title} {choice === 'api' ? <Badge>Recommended</Badge> : null}
                    </span>
                    <span className="mt-1 block text-sm text-fg-muted">{description}</span>
                  </span>
                </label>
              ))}
            </fieldset>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="primary"
                disabled={!data.canConfigure}
                onClick={() => changeStep('connect')}
              >
                Continue <ArrowRight aria-hidden />
              </Button>
              {data.doctor.ok ? (
                <Button
                  onClick={() => {
                    setSaved(data);
                    setApplied(false);
                    changeStep('ready');
                    onReady?.(data.doctor);
                  }}
                >
                  Use current {data.doctor.driver === 'mock' ? 'demo' : 'engine'}
                </Button>
              ) : null}
            </div>
          </div>
        ) : step === 'connect' ? (
          <form
            noValidate
            className="flex max-w-xl flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <h2 ref={heading} tabIndex={-1} className="text-base font-semibold outline-none">
              {mode === 'api'
                ? 'Connect your API account'
                : mode === 'cli'
                  ? 'Use your Claude Code login'
                  : 'Start without credentials'}
            </h2>
            {mode === 'api' ? (
              <>
                <p className="text-sm text-fg-muted">
                  Create a key in the{' '}
                  <a
                    className="text-accent underline underline-offset-4"
                    href="https://platform.claude.com/settings/keys"
                    target="_blank"
                    rel="noreferrer"
                  >
                    Claude Console
                  </a>
                  , then paste it here. API usage is billed separately from a Claude subscription.
                </p>
                <Field
                  id={`${ids}-key`}
                  label={hasKey ? 'API key (optional replacement)' : 'Anthropic API key'}
                  hint={
                    hasKey
                      ? 'A key is already available. Leave this empty to keep using it.'
                      : 'Saved in Orbit’s encrypted vault. It is never saved in browser storage or shown again.'
                  }
                >
                  <Input
                    ref={password}
                    id={`${ids}-key`}
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="sk-ant-…"
                    disabled={busy || !data.canConfigure}
                  />
                </Field>
              </>
            ) : mode === 'cli' ? (
              <>
                <p className="text-sm text-fg-muted">
                  Claude Code manages its own sign-in. On the computer running Orbit, open a
                  terminal and run:
                </p>
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-surface-2 px-3 py-2">
                  <code className="text-sm">claude auth login</code>
                  <Button size="sm" onClick={() => void copyLogin()}>
                    {copied ? 'Copied' : 'Copy command'}
                  </Button>
                </div>
                <p className="text-xs text-fg-subtle">
                  Finish sign-in there, then check below. Orbit never copies your Claude Code login
                  credentials. For shared or hosted Orbit, use an API key.
                </p>
              </>
            ) : (
              <>
                <p className="text-sm text-fg-muted">
                  The demo replays recorded conversations, including a request that waits for your
                  approval. Nothing calls a model and there are no charges.
                </p>
                {data.apiKeyStored ? (
                  <div className="flex flex-col gap-2 text-sm">
                    <p className="text-fg-muted">
                      Your saved API key is kept unless you remove it below.
                    </p>
                    <label className="flex items-start gap-2">
                      <input
                        type="checkbox"
                        checked={forgetKey}
                        onChange={(event) => setForgetKey(event.target.checked)}
                        className="mt-1 accent-accent"
                        disabled={busy || !data.canConfigure}
                      />
                      <span>Remove the saved API key from Orbit</span>
                    </label>
                    {forgetKey ? (
                      <p className="text-xs text-fg-subtle">
                        This removes Orbit’s copy. It does not revoke the key in your Anthropic
                        account. You will need to enter it again to reconnect.
                      </p>
                    ) : null}
                  </div>
                ) : null}
              </>
            )}
            {mode !== 'demo' ? (
              <>
                <Field
                  id={`${ids}-model`}
                  label="Default model"
                  hint="Used by Bots without their own model choice. Bots with a chosen model keep it."
                >
                  <Select
                    id={`${ids}-model`}
                    value={model}
                    onChange={(event) => setModel(event.target.value)}
                    disabled={busy || !data.canConfigure}
                  >
                    <option value="sonnet">Sonnet — balanced</option>
                    <option value="haiku">Haiku — quick tasks</option>
                    <option value="opus">Opus — complex tasks</option>
                    {!['sonnet', 'haiku', 'opus'].includes(model) ? (
                      <option value={model}>{model}</option>
                    ) : null}
                  </Select>
                </Field>
                <p className="text-xs text-fg-subtle">
                  The engine choice applies to every Bot, including scheduled Bots. They keep their
                  usual schedules and can use this engine after you save.
                </p>
              </>
            ) : null}
            {error ? (
              <p role="alert" className="rounded-md bg-danger-bg p-3 text-sm text-danger">
                {error}
              </p>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <Button disabled={busy} onClick={() => changeStep('engine')}>
                <ArrowLeft aria-hidden /> Back
              </Button>
              <Button type="submit" variant="primary" disabled={busy || !data.canConfigure}>
                {busy
                  ? 'Saving…'
                  : mode === 'api'
                    ? 'Save API setup'
                    : mode === 'cli'
                      ? 'Check login and save'
                      : forgetKey
                        ? 'Remove key and use demo'
                        : 'Use demo mode'}
              </Button>
            </div>
            <p className="text-xs text-fg-subtle">
              Saving setup does not send a test message or make a model request.
            </p>
          </form>
        ) : (
          <div className="flex flex-col gap-3" role="status">
            <h2
              ref={heading}
              tabIndex={-1}
              className="flex items-center gap-2 text-base font-semibold outline-none"
            >
              <Check className="size-5 text-success" aria-hidden />
              {d.driver === 'mock' ? 'Your demo is ready' : 'Your engine is configured'}
            </h2>
            <p className="max-w-prose text-sm text-fg-muted">
              {d.driver === 'mock'
                ? 'You can explore Orbit with recorded replies and approvals. Switch to a real engine here whenever you are ready.'
                : `Credentials are detected and ${d.models.default} is your default model. Your first message will check the live connection${d.driver === 'sdk' ? ' and may incur API charges' : ''}.`}
            </p>
            <p className="text-xs text-fg-subtle">
              {applied ? 'Your choice is saved for future restarts. ' : ''}No model request was made
              during setup.
            </p>
            <div>
              <Button onClick={() => changeStep('engine')}>Change engine</Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
