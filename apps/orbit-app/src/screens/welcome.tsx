/** @jsxRuntime automatic @jsxImportSource react */
import { TIER_WORD, Tier } from '@orbit/core/browser';
import { useNavigate } from '@tanstack/react-router';
import { Octagon, Play, Plus, ShieldCheck, Wallet } from 'lucide-react';
import { useState } from 'react';
import { ErrorState, ListSkeleton } from '../components/states';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { useActions } from '../lib/actions';
import { useDoctor } from '../lib/queries';

const KEY = 'orbit.onboarded';

export function onboarded(): boolean {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return true;
  }
}

export function markOnboarded(): void {
  try {
    localStorage.setItem(KEY, '1');
  } catch {
    // ignore
  }
}

/** First run: is the engine ready, how Orbit keeps you in control, the first Bot. */
export function WelcomeScreen() {
  const doctor = useDoctor();
  const actions = useActions();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const d = doctor.data;

  const demo = async () => {
    setBusy(true);
    try {
      const bot = await actions.createBot({
        name: 'Reply drafter (demo)',
        goal: 'Draft and send a reply to Ada about Tuesday’s meeting.',
        tools: ['Read', 'Write'],
        mock: { fixture: 'send-email' },
      });
      const run = await actions.runBot(bot);
      markOnboarded();
      await navigate({ to: '/runs/$runId', params: { runId: run.runId } });
    } catch {
      // toast shown
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex max-w-3xl flex-col gap-4">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Welcome to Orbit</h1>
        <p className="mt-1 text-fg-muted">
          Always-on Bots that work toward a goal — and ask you before anything leaves their sandbox.
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>1 · Your engine</CardTitle>
          {d ? (
            <Badge tone={d.ok ? 'success' : 'danger'}>
              {d.ok ? '✔ ready' : '✘ needs attention'}
            </Badge>
          ) : null}
        </CardHeader>
        <CardContent className="text-sm">
          {doctor.isPending ? (
            <ListSkeleton rows={1} />
          ) : doctor.isError ? (
            <ErrorState error={doctor.error} />
          ) : d ? (
            <div className="flex flex-col gap-2">
              <p>
                {d.driver === 'mock'
                  ? 'Demo mode: the mock driver replays recorded runs, so nothing calls Claude and nothing costs anything.'
                  : `Runs use the ${d.driver ?? 'no'} driver — ${d.authLabel}.`}
              </p>
              {d.refusal ? (
                <p className="rounded-md bg-danger-bg px-3 py-2 text-danger">
                  {d.refusal.message} {d.refusal.hint}
                </p>
              ) : null}
              {d.onboarding ? (
                <div className="rounded-md bg-info-bg px-3 py-2 text-info">
                  <p className="font-medium">{d.onboarding.reason}</p>
                  <ol className="mt-1 list-decimal pl-5">
                    {d.onboarding.steps.map((s) => (
                      <li key={s}>{s}</li>
                    ))}
                  </ol>
                </div>
              ) : null}
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>2 · You stay in control</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 text-sm">
          <ul className="flex flex-col gap-1.5">
            {Tier.options.map((t) => (
              <li key={t} className="flex flex-wrap items-baseline gap-2">
                <Badge tone={TIER_WORD[t].tone}>
                  <span aria-hidden>{TIER_WORD[t].mark}</span>
                  {TIER_WORD[t].label}
                </Badge>
                <span className="text-fg-muted">{TIER_WORD[t].meaning}</span>
              </li>
            ))}
          </ul>
          <p className="flex items-start gap-2 text-fg-muted">
            <ShieldCheck className="mt-0.5 size-4 shrink-0 text-accent" aria-hidden /> Requests wait
            in your Inbox with the exact arguments; you approve, edit, or deny with a reason the Bot
            sees.
          </p>
          <p className="flex items-start gap-2 text-fg-muted">
            <Wallet className="mt-0.5 size-4 shrink-0 text-accent" aria-hidden /> Budgets (tool
            calls, time, tokens, cost, runs per day) are enforced by Orbit itself.
          </p>
          <p className="flex items-start gap-2 text-fg-muted">
            <Octagon className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden /> A kill switch per
            Run, per Bot and for everything.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>3 · Your first Bot</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          <Button
            variant="primary"
            onClick={() => {
              markOnboarded();
              void navigate({ to: '/bots/new' });
            }}
          >
            <Plus aria-hidden /> Create a Bot
          </Button>
          {d?.driver === 'mock' ? (
            <Button disabled={busy} onClick={() => void demo()}>
              <Play aria-hidden /> Try a demo that asks for approval
            </Button>
          ) : null}
          <Button
            variant="ghost"
            onClick={() => {
              markOnboarded();
              void navigate({ to: '/inbox' });
            }}
          >
            Skip for now
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
