/** @jsxRuntime automatic @jsxImportSource react */
import { RUN_STATUS, RunStatus, Tier } from '@orbit/core/browser';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { Play, Plus } from 'lucide-react';
import { RunSparkline, Meter } from '../components/sparkline';
import { EmptyState, ErrorState, ListSkeleton } from '../components/states';
import { PausedBadge, StatusBadge, TierBadge } from '../components/status';
import { Button } from '../components/ui/button';
import { Field, Input, Select, Textarea } from '../components/ui/input';
import { Kbd, Switch } from '../components/ui/misc';
import { OrbitError, type RunState } from '@orbit/core/browser';

const meta: Meta = { title: 'Components/Primitives' };
export default meta;

export const Buttons: StoryObj = {
  render: () => (
    <div className="flex flex-wrap items-center gap-2">
      <Button variant="primary">
        <Plus aria-hidden /> New Bot
      </Button>
      <Button>Secondary</Button>
      <Button variant="ghost">Ghost</Button>
      <Button variant="success">
        Approve <Kbd className="border-transparent bg-black/15 text-inherit">a</Kbd>
      </Button>
      <Button variant="danger">Stop</Button>
      <Button variant="link">Link</Button>
      <Button size="sm">
        <Play aria-hidden /> Run
      </Button>
      <Button disabled>Disabled</Button>
    </div>
  ),
};

export const Status: StoryObj = {
  render: () => (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-2">
        {RunStatus.options.map((s) => (
          <StatusBadge key={s} status={s} />
        ))}
        <PausedBadge />
      </div>
      <div className="flex flex-wrap gap-2">
        {Tier.options.map((t) => (
          <TierBadge key={t} tier={t} />
        ))}
      </div>
      <ul className="text-xs text-fg-muted">
        {RunStatus.options.map((s) => (
          <li key={s}>
            {RUN_STATUS[s].mark} {RUN_STATUS[s].label} — {RUN_STATUS[s].meaning}
          </li>
        ))}
      </ul>
    </div>
  ),
};

export const Fields: StoryObj = {
  render: () => (
    <div className="grid max-w-md gap-3">
      <Field id="s-name" label="Name" hint="Shown everywhere.">
        <Input id="s-name" defaultValue="Mailer" />
      </Field>
      <Field id="s-goal" label="Goal">
        <Textarea id="s-goal" defaultValue="Reply to Ada about Tuesday" />
      </Field>
      <Field id="s-sel" label="Runs">
        <Select id="s-sel">
          <option>when I start it</option>
        </Select>
      </Field>
      <label className="flex items-center gap-2 text-sm" htmlFor="s-sw">
        <Switch id="s-sw" defaultChecked /> Resume automatically
      </label>
    </div>
  ),
};

const run = (status: RunState['status'], tokens: number) =>
  ({
    runId: `r${tokens}${status}`,
    status,
    totals: { tokens, turns: 1, costUsd: 0, activeMs: 0 },
  }) as RunState;

export const Meters: StoryObj = {
  render: () => (
    <div className="grid max-w-sm gap-4">
      <RunSparkline
        className="h-8"
        runs={[
          run('completed', 900),
          run('failed', 300),
          run('completed', 1200),
          run('waiting_approval', 500),
          run('rate_limited', 200),
        ]}
      />
      <Meter label="Tool calls" value={34} max={200} />
      <Meter label="Tokens" value={9_200} max={10_000} />
      <Meter label="Cost" value={0.42} max={null} format={(n) => `$${n.toFixed(2)}`} />
    </div>
  ),
};

export const States: StoryObj = {
  render: () => (
    <div className="grid gap-4">
      <ListSkeleton rows={2} />
      <EmptyState title="Nothing needs you">
        When a Bot wants to act outside its workspace, the request waits here.
      </EmptyState>
      <ErrorState
        error={
          new OrbitError('daemon_unavailable', 'Cannot reach orbitd', {
            hint: 'Start it with orbit daemon start.',
          })
        }
        retry={() => undefined}
      />
    </div>
  ),
};
