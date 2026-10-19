import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunEventBody } from '@orbit/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MockDriver, applyFileEffect } from './mock';
import type { DriverRunRequest, ToolPermissionDecision } from './types';

let dir: string;
let ws: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orbit-mock-'));
  ws = join(dir, 'ws');
  mkdirSync(ws);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('demo file effects (ADR-020)', () => {
  it('Write creates the file (and folders), Edit changes it', () => {
    applyFileEffect(ws, 'Write', { file_path: join(ws, 'notes', 'a.md'), content: 'Hello Ada' });
    expect(readFileSync(join(ws, 'notes', 'a.md'), 'utf8')).toBe('Hello Ada');
    applyFileEffect(ws, 'Edit', {
      file_path: join(ws, 'notes', 'a.md'),
      old_string: 'Ada',
      new_string: 'Grace',
    });
    expect(readFileSync(join(ws, 'notes', 'a.md'), 'utf8')).toBe('Hello Grace');
  });

  it('leaves paths outside the workspace, through links, and other tools alone', () => {
    applyFileEffect(ws, 'Write', { file_path: join(dir, 'outside.txt'), content: 'x' });
    applyFileEffect(ws, 'Write', { file_path: join(ws, '..', 'outside2.txt'), content: 'x' });
    expect(existsSync(join(dir, 'outside.txt'))).toBe(false);
    expect(existsSync(join(dir, 'outside2.txt'))).toBe(false);
    symlinkSync(dir, join(ws, 'up'));
    applyFileEffect(ws, 'Write', { file_path: join(ws, 'up', 'evil.txt'), content: 'x' });
    expect(existsSync(join(dir, 'evil.txt'))).toBe(false);
    writeFileSync(join(dir, 'target.txt'), 'safe');
    symlinkSync(join(dir, 'target.txt'), join(ws, 'link.txt'));
    applyFileEffect(ws, 'Write', { file_path: join(ws, 'link.txt'), content: 'overwritten' });
    expect(readFileSync(join(dir, 'target.txt'), 'utf8')).toBe('safe');
    applyFileEffect(ws, 'Bash', { command: 'touch x', file_path: join(ws, 'x') });
    expect(existsSync(join(ws, 'x'))).toBe(false);
  });

  it('a replay writes what policy allowed and not what it denied', async () => {
    const replay = async (
      driver: MockDriver,
      decide: (tool: string) => ToolPermissionDecision,
    ): Promise<RunEventBody[]> => {
      const req: DriverRunRequest = {
        runId: 'run_1',
        prompt: 'go',
        cwd: ws,
        model: null,
        appendSystemPrompt: null,
        tools: null,
        maxTurns: null,
        resumeSessionId: null,
        sessionId: 'session-1',
        permission: (r) => Promise.resolve(decide(r.toolName)),
        signal: new AbortController().signal,
        mockFixture: 'web-then-write',
      };
      const out: RunEventBody[] = [];
      for await (const e of driver.run(req)) out.push(e);
      return out;
    };
    const allow = { behavior: 'allow', reason: 'ok', tier: 'WRITE_LOCAL' } as const;
    const events = await replay(new MockDriver(), () => allow);
    expect(events.at(-1)?.type).toBe('run.completed');
    const page = join(ws, 'notes', 'page.md');
    expect(readFileSync(page, 'utf8')).toBe('Launch page: owner Ada.\n');
    rmSync(join(ws, 'notes'), { recursive: true });
    await replay(new MockDriver({ fileEffects: false }), () => allow);
    expect(existsSync(page)).toBe(false);
    await replay(new MockDriver(), (tool) =>
      tool === 'Write'
        ? { behavior: 'deny', reason: 'not here', tier: 'WRITE_LOCAL' }
        : { behavior: 'allow', reason: 'ok', tier: 'READ' },
    );
    expect(existsSync(page)).toBe(false);
  });
});
