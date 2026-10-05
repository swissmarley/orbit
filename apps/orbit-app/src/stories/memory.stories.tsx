/** @jsxRuntime automatic @jsxImportSource react */
import type { Meta, StoryObj } from '@storybook/react-vite';
import { Timeline } from '../components/timeline';
import { buildTimeline } from '../lib/timeline';
import { TrustBadge } from '../screens/memory';
import { teamEvents } from './fixtures';

const meta: Meta = { title: 'Memory and teams' };
export default meta;

export const TrustBadges: StoryObj = {
  render: () => (
    <div className="flex gap-2">
      <TrustBadge memory={{ taint: [] }} />
      <TrustBadge memory={{ taint: ['WebFetch'] }} />
    </div>
  ),
};

export const DelegationTimeline: StoryObj = {
  render: () => <Timeline items={buildTimeline(teamEvents)} className="h-[28rem]" />,
};
