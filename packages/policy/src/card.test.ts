import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Tier } from '@orbit/core';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApprovalCard, diffForTool } from './card';

const ws = mkdtempSync(join(tmpdir(), 'orbit-card-'));
mkdirSync(join(ws, 'docs'));
const EXISTING = join(ws, 'docs', 'plan.md');
const PLAN = 'line one\nfoo here\nline three\nfoo again\n';
writeFileSync(EXISTING, PLAN);
afterAll(() => rmSync(ws, { recursive: true, force: true }));

/** Changed lines of a unified diff (headers excluded). */
function changes(diff: string | null): string[] {
  expect(diff).not.toBeNull();
  return (diff ?? '')
    .split('\n')
    .filter((l) => /^[+-]/.test(l) && !l.startsWith('+++') && !l.startsWith('---'));
}

function build(over: Partial<Parameters<typeof buildApprovalCard>[0]> = {}) {
  return buildApprovalCard({
    toolName: 'mcp__gmail__send_email',
    input: { to: 'ada@example.com', subject: 'Hi', body: 'Hello' },
    tier: 'EXTERNAL',
    why: 'Ada asked for the report.',
    botId: 'bot_1',
    botName: 'Inbox Triage',
    runId: 'run_1',
    workspace: ws,
    untrusted: [],
    ...over,
  });
}

describe('buildApprovalCard', () => {
  it('carries the exact payload, Bot and Run identity', () => {
    const input = { to: 'ada@example.com', subject: 'Hi', body: 'Hello' };
    const c = build({ input });
    expect(c).toEqual({
      what: 'send email (gmail) → ada@example.com',
      why: 'Ada asked for the report.',
      toolName: 'mcp__gmail__send_email',
      tier: 'EXTERNAL',
      payload: input,
      diff: null,
      botId: 'bot_1',
      botName: 'Inbox Triage',
      runId: 'run_1',
      untrusted: [],
      risk: 'Has effects outside the sandbox (sends, posts, merges, deletes or contacts other systems).',
      delegatedBy: null,
    });
  });

  describe('what', () => {
    const long = `echo ${'x'.repeat(200)}`;
    it.each<[string, string, Record<string, unknown>, string]>([
      [
        'file tool names the path',
        'Write',
        { file_path: EXISTING, content: '' },
        `Write ${EXISTING}`,
      ],
      [
        'shell shows the command',
        'Bash',
        { command: 'git push origin main' },
        'Run `git push origin main`',
      ],
      [
        'long shell commands are truncated',
        'Bash',
        { command: long },
        `Run \`${long.slice(0, 117)}…\``,
      ],
      [
        'MCP send names the recipient',
        'mcp__gmail__send_email',
        { to: 'ada@example.com' },
        'send email (gmail) → ada@example.com',
      ],
      [
        'MCP post names the channel',
        'mcp__slack__post_message',
        { channel: '#eng', text: 'hi' },
        'post message (slack) → #eng',
      ],
      [
        'MCP recipient field',
        'mcp__sms__send_text',
        { recipient: '+15550100' },
        'send text (sms) → +15550100',
      ],
      [
        'MCP without a target',
        'mcp__github__merge_pull_request',
        { number: 7 },
        'merge pull request (github)',
      ],
      [
        'non-string target is ignored',
        'mcp__gmail__send_email',
        { to: ['a@b.c'] },
        'send email (gmail)',
      ],
      ['other tools fall back to their name', 'WebFetch', { url: 'https://x' }, 'WebFetch'],
    ])('%s', (_scenario, toolName, input, what) => {
      expect(build({ toolName, input }).what).toBe(what);
    });

    it('truncated command is exactly 117 chars + ellipsis', () => {
      const what = build({ toolName: 'Bash', input: { command: long } }).what;
      expect(what.length).toBe('Run ``'.length + 118);
    });
  });

  describe('why', () => {
    it.each<[string, string | null, string]>([
      ['Bot explanation is kept (trimmed)', '  Ada asked for it.\n', 'Ada asked for it.'],
      ['no explanation → fallback', null, 'The Bot did not explain this step.'],
      ['empty explanation → fallback', '', 'The Bot did not explain this step.'],
      ['whitespace-only explanation → fallback', '  \n\t ', 'The Bot did not explain this step.'],
    ])('%s', (_scenario, why, expected) => {
      expect(build({ why }).why).toBe(expected);
    });
  });

  describe('risk and untrusted influences', () => {
    it.each<[Tier, RegExp]>([
      ['READ', /^Reads data only\.$/],
      ['WRITE_LOCAL', /^Changes files inside the Bot workspace\.$/],
      ['EXTERNAL', /^Has effects outside the sandbox/],
      ['FINANCIAL', /never executes this; it can only be prepared for you\.$/],
    ])('%s risk text, no untrusted suffix when the Run is clean', (tier, risk) => {
      const c = build({ tier });
      expect(c.risk).toMatch(risk);
      expect(c.risk).not.toMatch(/Untrusted/);
      expect(c.untrusted).toEqual([]);
    });

    it('lists untrusted sources and warns in the risk text', () => {
      const sources = ['WebFetch', 'mcp__gmail__get_message'];
      const c = build({ untrusted: sources });
      expect(c.untrusted).toEqual(sources);
      expect(c.untrusted).not.toBe(sources); // a copy: later taint does not rewrite a stored card
      expect(c.risk).toBe(
        'Has effects outside the sandbox (sends, posts, merges, deletes or contacts other systems). Untrusted content influenced this Run.',
      );
    });
  });

  it('building a card never touches the file it diffs', () => {
    build({
      toolName: 'Write',
      tier: 'WRITE_LOCAL',
      input: { file_path: EXISTING, content: 'replaced\n' },
    });
    expect(readFileSync(EXISTING, 'utf8')).toBe(PLAN);
  });
});

describe('diffForTool', () => {
  it('Write over an existing file: removed and added lines, with paths in the header', () => {
    const diff = diffForTool(
      'Write',
      { file_path: EXISTING, content: 'line one\nbar here\nline three\nfoo again\n' },
      ws,
    );
    expect(diff).toContain(`--- ${EXISTING}\tcurrent`);
    expect(diff).toContain(`+++ ${EXISTING}\tproposed`);
    expect(changes(diff)).toEqual(['-foo here', '+bar here']);
  });

  it('Write with a workspace-relative path diffs against the file in the workspace', () => {
    const diff = diffForTool(
      'Write',
      { file_path: 'docs/plan.md', content: PLAN.replace('line one', 'LINE ONE') },
      ws,
    );
    expect(changes(diff)).toEqual(['-line one', '+LINE ONE']);
  });

  it('Write of a new file: only added lines', () => {
    const diff = diffForTool('Write', { file_path: join(ws, 'new.md'), content: 'a\nb\n' }, ws);
    expect(changes(diff)).toEqual(['+a', '+b']);
  });

  it.each<[string, boolean | undefined, string[]]>([
    ['Edit replaces the first occurrence only', undefined, ['-foo here', '+baz here']],
    ['Edit with replace_all: false replaces the first only', false, ['-foo here', '+baz here']],
    [
      'Edit with replace_all replaces every occurrence',
      true,
      ['-foo here', '+baz here', '-foo again', '+baz again'],
    ],
  ])('%s', (_scenario, replaceAll, expected) => {
    const input: Record<string, unknown> = {
      file_path: EXISTING,
      old_string: 'foo',
      new_string: 'baz',
    };
    if (replaceAll !== undefined) input.replace_all = replaceAll;
    expect(changes(diffForTool('Edit', input, ws))).toEqual(expected);
  });

  it('MultiEdit applies edits in order, each to the result of the previous one', () => {
    const diff = diffForTool(
      'MultiEdit',
      {
        file_path: EXISTING,
        edits: [
          { old_string: 'line one', new_string: 'first line' },
          { old_string: 'first', new_string: '1st' },
          { old_string: 'line three', new_string: 'third line' },
        ],
      },
      ws,
    );
    expect(changes(diff)).toEqual(['-line one', '+1st line', '-line three', '+third line']);
  });

  it.each<[string, string, Record<string, unknown>]>([
    ['shell has no diff', 'Bash', { command: 'rm -rf build' }],
    ['Read has no diff', 'Read', { file_path: EXISTING }],
    ['MCP tools have no diff', 'mcp__gmail__send_email', { to: 'a@b.c' }],
    ['Write without content has no diff', 'Write', { file_path: EXISTING }],
    ['Write without a path has no diff', 'Write', { content: 'x' }],
    [
      'MultiEdit without an edits array has no diff',
      'MultiEdit',
      { file_path: EXISTING, edits: 'nope' },
    ],
  ])('%s', (_scenario, tool, input) => {
    expect(diffForTool(tool, input, ws)).toBeNull();
  });

  it('a card for Write embeds the same diff', () => {
    const input = { file_path: EXISTING, content: 'x\n' };
    expect(build({ toolName: 'Write', tier: 'WRITE_LOCAL', input }).diff).toBe(
      diffForTool('Write', input, ws),
    );
  });

  // BUG (reported): Edit/MultiEdit use String.prototype.replace with a string
  // replacement, so `$&`, `$$`, `` $` `` and `$'` in new_string are expanded as
  // replacement patterns. The card then shows content that differs from what
  // the engine writes (Claude Code writes new_string literally); replace_all
  // (split/join) is already literal, so the two modes disagree.
  it.each<[string, string, string]>([
    ['"$$" in shell snippets', 'echo "$$PID"', '+echo "$$PID" here'],
    ['"$&" in a regex replacement snippet', "s.replace(re, '$&!')", "+s.replace(re, '$&!') here"],
  ])('Edit diff shows new_string literally: %s', (_scenario, newString, expectedLine) => {
    const diff = diffForTool(
      'Edit',
      { file_path: EXISTING, old_string: 'foo', new_string: newString },
      ws,
    );
    expect(changes(diff)).toContain(expectedLine);
  });

  it('MultiEdit diff shows new_string literally ("$\'" is not expanded)', () => {
    const diff = diffForTool(
      'MultiEdit',
      { file_path: EXISTING, edits: [{ old_string: 'line three', new_string: "cost: $'" }] },
      ws,
    );
    expect(changes(diff)).toContain("+cost: $'");
  });

  // BUG (reported): MultiEdit edits may carry `replace_all: true` (Claude Code
  // MultiEdit schema); diffForTool ignores it, so the card under-reports changes.
  it('MultiEdit honours per-edit replace_all', () => {
    const diff = diffForTool(
      'MultiEdit',
      { file_path: EXISTING, edits: [{ old_string: 'foo', new_string: 'baz', replace_all: true }] },
      ws,
    );
    expect(changes(diff)).toEqual(['-foo here', '+baz here', '-foo again', '+baz again']);
  });
});
