/** @jsxRuntime automatic @jsxImportSource react */
import type { Meta, StoryObj } from '@storybook/react-vite';
import { DiffView } from '../components/diff-view';
import { Timeline } from '../components/timeline';
import { lineDiff, specDiff } from '../lib/diff';
import { buildTimeline } from '../lib/timeline';
import { runEvents } from './fixtures';

const meta: Meta = { title: 'Run/Timeline and diffs' };
export default meta;

export const LiveTimeline: StoryObj = {
  render: () => <Timeline items={buildTimeline(runEvents)} className="h-[28rem]" />,
};

export const FileDiff: StoryObj = {
  render: () => (
    <DiffView
      label="draft.md"
      lines={lineDiff('Hi Ada,\nTBD\nThanks\n', 'Hi Ada,\nTuesday 09:00 UTC works.\nThanks\n')}
    />
  ),
};

export const ConfigVersions: StoryObj = {
  render: () => (
    <DiffView
      label="version 1 → version 2"
      lines={specDiff(
        { name: 'Mailer', goal: 'Reply to Ada', tools: ['Read'], budgets: { maxRunsPerDay: 50 } },
        {
          name: 'Mailer',
          goal: 'Reply to Ada',
          tools: ['Read', 'Write'],
          budgets: { maxRunsPerDay: 20 },
        },
      )}
    />
  ),
};
