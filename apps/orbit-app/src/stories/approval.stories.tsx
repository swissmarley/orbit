/** @jsxRuntime automatic @jsxImportSource react */
import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { ApprovalCard, type CardMode } from '../components/approval-card';
import { approval, tainted, withDiff } from './fixtures';

function Card({ which, mode: initial }: { which: 'plain' | 'tainted' | 'diff'; mode: CardMode }) {
  const [mode, setMode] = useState<CardMode>(initial);
  const a = which === 'tainted' ? tainted : which === 'diff' ? withDiff : approval;
  return (
    <div className="max-w-2xl rounded-lg border border-border bg-surface px-5 py-4">
      <ApprovalCard
        approval={a}
        mode={mode}
        onMode={setMode}
        onApprove={() => undefined}
        onDeny={() => undefined}
      />
    </div>
  );
}

const meta: Meta<typeof Card> = {
  title: 'Inbox/Approval card',
  component: Card,
  args: { which: 'plain', mode: 'card' },
  argTypes: {
    which: { control: 'inline-radio', options: ['plain', 'tainted', 'diff'] },
    mode: { control: 'inline-radio', options: ['card', 'edit', 'deny', 'always'] },
  },
};
export default meta;
type Story = StoryObj<typeof Card>;
export const Review: Story = {};
export const UntrustedInput: Story = { args: { which: 'tainted' } };
export const WithDiff: Story = { args: { which: 'diff' } };
export const Edit: Story = { args: { mode: 'edit' } };
export const Deny: Story = { args: { mode: 'deny' } };
export const AlwaysAllow: Story = { args: { mode: 'always' } };
