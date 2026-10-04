import { Bot, type BotSpecInput } from '@orbit/core';
import type { CommandOptions, CommandResult, CommandRunner, SandboxSupport } from '../src/types';

export function makeBot(spec: Partial<BotSpecInput> = {}, id = 'bot_test1'): Bot {
  const now = new Date().toISOString();
  return Bot.parse({
    id,
    version: 1,
    spec: { name: 'Test Bot', goal: 'Test the sandbox', ...spec },
    createdAt: now,
    updatedAt: now,
  });
}

export const FULL_SUPPORT: SandboxSupport = {
  docker: { available: true, version: '29.0.0', error: null },
  engineSandbox: { available: true, missing: [], platform: 'linux' },
};

export const NO_SUPPORT: SandboxSupport = {
  docker: { available: false, version: null, error: 'docker CLI not found on PATH' },
  engineSandbox: { available: false, missing: ['bwrap'], platform: 'linux' },
};

export interface RecordedCall {
  file: string;
  args: string[];
  opts: CommandOptions | undefined;
}

type Reply = Partial<CommandResult> | Error | undefined;

/** A CommandRunner that records calls and answers from `reply` (default: exit 0, no output). */
export function fakeRunner(
  reply: (file: string, args: string[]) => Reply = () => undefined,
): CommandRunner & { calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const run = (async (file: string, args: string[], opts?: CommandOptions) => {
    calls.push({ file, args, opts });
    const r = reply(file, args);
    if (r instanceof Error) throw r;
    return { code: 0, stdout: '', stderr: '', ...r };
  }) as CommandRunner & { calls: RecordedCall[] };
  run.calls = calls;
  return run;
}
