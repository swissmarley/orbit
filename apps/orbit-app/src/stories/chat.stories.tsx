/** @jsxRuntime automatic @jsxImportSource react */
import {
  AVATAR_CHARACTERS,
  AVATAR_COLORS,
  type BotAvatar,
  type RunEvent,
  replayRun,
} from '@orbit/core/browser';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { Avatar, AvatarPicker } from '../components/avatar';
import {
  AssistantMessage,
  Composer,
  ToolCard,
  ToolGroup,
  Typing,
  UserMessage,
} from '../components/chat';
import { buildConversation } from '../lib/conversation';
import { runEvents } from './fixtures';

const meta: Meta = { title: 'Chat/Avatars and messages' };
export default meta;

const demoBot = {
  id: 'bot_demo',
  version: 1,
  pausedAt: null,
  createdAt: '2026-10-05T09:00:00.000Z',
  updatedAt: '2026-10-05T09:00:00.000Z',
  spec: { name: 'Scout', goal: 'Research launch pages' },
} as unknown as Parameters<typeof ToolCard>[0]['bot'];

export const Avatars: StoryObj = {
  render: () => (
    <div className="flex flex-col gap-2">
      {AVATAR_COLORS.map((color) => (
        <div key={color} className="flex items-center gap-3">
          <span className="w-14 text-xs text-fg-muted">{color}</span>
          {AVATAR_CHARACTERS.map((character) => (
            <Avatar
              key={character}
              avatar={{ character, color }}
              name={`${color} ${character}`}
              size={48}
            />
          ))}
        </div>
      ))}
    </div>
  ),
};

export const AvatarStates: StoryObj = {
  render: () => (
    <div className="flex items-end gap-6">
      {(['idle', 'working', 'attention', 'paused'] as const).map((state) => (
        <figure key={state} className="flex flex-col items-center gap-1">
          <Avatar
            avatar={{ character: 'star', color: 'violet' }}
            name="Scout"
            state={state}
            size={72}
          />
          <figcaption className="text-xs text-fg-muted">{state}</figcaption>
        </figure>
      ))}
    </div>
  ),
};

function Picker() {
  const [value, setValue] = useState<BotAvatar>({ character: 'robot', color: 'teal' });
  return <AvatarPicker value={value} onChange={setValue} name="Scout" />;
}

export const AvatarPickerStory: StoryObj = { name: 'Avatar picker', render: () => <Picker /> };

const events: RunEvent[] = runEvents;
const run = replayRun(events);
const items = run ? buildConversation([{ run, events }]) : [];

export const Messages: StoryObj = {
  render: () => (
    <div className="flex max-w-2xl flex-col gap-4">
      {items.map((item) =>
        item.kind === 'user' ? (
          <UserMessage key={item.key} item={item} />
        ) : item.kind === 'assistant' ? (
          <AssistantMessage key={item.key} item={item} />
        ) : item.kind === 'tool' ? (
          <ToolCard key={item.key} tool={item.tool} bot={demoBot} />
        ) : item.kind === 'group' ? (
          <ToolGroup key={item.key} tools={item.tools} />
        ) : null,
      )}
      <AssistantMessage
        item={{
          kind: 'assistant',
          key: 'md',
          runId: 'run_demo',
          ts: '2026-10-05T09:16:00.000Z',
          text: 'Saved as `notes.md` — **41 words**:\n\n1. Define the scope\n   - State the purpose\n2. Ship it',
        }}
      />
      <Typing text="Scout is working" />
    </div>
  ),
};

export const ComposerStory: StoryObj = {
  name: 'Composer',
  render: () => (
    <div className="max-w-2xl">
      <Composer
        botName="Scout"
        state={{ canSend: true, hint: null, stoppable: false, resumable: false }}
        onSend={() => Promise.resolve(true)}
        footer="Scout works on its own computer; anything outside it asks you first."
      />
    </div>
  ),
};
