/** @jsxRuntime automatic @jsxImportSource react */
import { TIER_WORD, Tier } from '@orbit/core/browser';
import { useNavigate } from '@tanstack/react-router';
import { Octagon, Play, Plus, ShieldCheck, Wallet } from 'lucide-react';
import { useState } from 'react';
import { Avatar } from '../components/avatar';
import { EngineSetup } from '../components/engine-setup';
import { RoleGate } from '../components/role-gate';
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
  const [ready, setReady] = useState(false);
  const d = doctor.data;

  const demo = async () => {
    setBusy(true);
    try {
      const bot = await actions.createBot({
        name: 'Reply drafter (demo)',
        goal: 'Draft and send a reply to Ada about Tuesday’s meeting.',
        tools: ['Read', 'Write'],
        mock: { fixture: 'send-email' },
        avatar: { character: 'star', color: 'violet' },
      });
      // The demo is a chat: the Bot drafts, then asks before it sends (ADR-020).
      const run = await actions.sendMessage(bot, bot.spec.goal);
      markOnboarded();
      await navigate({
        to: '/chat/$botId',
        params: { botId: bot.id },
        search: { c: run.conversationId },
      });
    } catch {
      // toast shown
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex max-w-3xl flex-col gap-4">
      <header>
        <div className="mb-3 flex items-end gap-1">
          <Avatar avatar={{ character: 'star', color: 'violet' }} size={64} decorative />
          <Avatar avatar={{ character: 'robot', color: 'teal' }} size={52} decorative />
          <Avatar avatar={{ character: 'planet', color: 'amber' }} size={44} decorative />
        </div>
        <h1 className="text-2xl font-semibold tracking-tight">Welcome to Orbit</h1>
        <p className="mt-1 text-fg-muted">
          Always-on Bots you talk to, each with its own computer — and they ask you before anything
          leaves it.
        </p>
      </header>

      <EngineSetup onReady={() => setReady(true)} />

      {ready ? (
        <>
          <Card>
            <CardHeader>
              <CardTitle>You stay in control</CardTitle>
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
                <ShieldCheck className="mt-0.5 size-4 shrink-0 text-accent" aria-hidden /> Requests
                appear right in the chat (and in your Inbox) with the exact arguments; you approve,
                edit, or deny with a reason the Bot sees.
              </p>
              <p className="flex items-start gap-2 text-fg-muted">
                <Wallet className="mt-0.5 size-4 shrink-0 text-accent" aria-hidden /> Budgets (tool
                calls, time, tokens, cost, runs per day) are enforced by Orbit itself.
              </p>
              <p className="flex items-start gap-2 text-fg-muted">
                <Octagon className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden /> A kill switch
                per Run, per Bot and for everything.
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Your first Bot</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-wrap gap-2">
              <p className="w-full text-sm text-fg-muted">
                Give your Bot a goal and review its limits. Creating it does not start a model
                request.
              </p>
              <RoleGate role="owner">
                <Button
                  variant="primary"
                  onClick={() => {
                    markOnboarded();
                    void navigate({ to: '/bots/new' });
                  }}
                >
                  <Plus aria-hidden /> Create a Bot
                </Button>
              </RoleGate>
              {d?.driver === 'mock' ? (
                <RoleGate role="owner">
                  <Button disabled={busy} onClick={() => void demo()}>
                    <Play aria-hidden /> Try a demo chat that asks for approval
                  </Button>
                </RoleGate>
              ) : null}
            </CardContent>
          </Card>
        </>
      ) : null}
      <div>
        <Button
          variant="ghost"
          onClick={() => {
            markOnboarded();
            void navigate({ to: '/bots' });
          }}
        >
          {ready ? 'Open Bots' : 'Explore first'}
        </Button>
      </div>
    </div>
  );
}
