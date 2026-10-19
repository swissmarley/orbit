import { replayRun, type RunState } from '@orbit/core/browser';
import { describe, expect, it } from 'vitest';
import { auditAction, auditActor, auditRef } from './audit';
import { delegationTree, treeSize } from './delegation';

function run(runId: string, botId: string, children: string[] = []): RunState {
  const s = replayRun([
    {
      id: 1,
      runId,
      botId,
      seq: 1,
      ts: '2026-10-05T10:00:00.000Z',
      type: 'run.queued',
      data: {
        trigger: { kind: 'manual', source: null },
        prompt: 'p',
        priority: 0,
        fixture: null,
        parentRunId: null,
        depth: 0,
        inheritedTaint: [],
        budgetCap: null,
        conversationId: null,
        continuesRunId: null,
      },
    },
  ])!;
  return {
    ...s,
    children: children.map((c) => ({ runId: c, botId: 'b', botName: 'B', status: 'running' })),
  };
}

describe('delegationTree', () => {
  it('builds the tree from the root, marks the current Run and survives cycles', () => {
    const runs = [run('r1', 'bot_a', ['r2', 'r3']), run('r2', 'bot_b', ['r1']), run('r3', 'bot_c')];
    const names: Record<string, string> = { bot_a: 'Lead', bot_b: 'Research', bot_c: 'Writer' };
    const t = delegationTree(runs, 'r1', (id) => names[id] ?? id, 'r2');
    expect(t?.botName).toBe('Lead');
    expect(t?.children.map((c) => [c.botName, c.current])).toEqual([
      ['Research', true],
      ['Writer', false],
    ]);
    expect(t?.children[0]?.children).toEqual([]);
    expect(treeSize(t)).toBe(3);
    expect(delegationTree(runs, 'nope', String, 'r1')).toBeNull();
  });
});

describe('audit rows as names and links', () => {
  const names = (id: string) => (id === 'bot_01abc' ? 'Mailer' : undefined);

  it('names Bots and links Runs, memories and rules', () => {
    expect(auditRef('bot_01abc', names)).toMatchObject({
      text: 'Mailer',
      link: { to: '/bots/$botId', params: { botId: 'bot_01abc' } },
    });
    expect(auditRef('bot_gone12345678', names)?.text).toBe('Bot …12345678');
    expect(auditRef('run_01m45w74qb38vj71w4texx', names)).toMatchObject({
      text: 'run …71w4texx',
      link: { to: '/runs/$runId' },
    });
    expect(auditRef('mem_x1', names)?.link).toEqual({
      to: '/memory',
      search: { memory: 'mem_x1' },
    });
    expect(auditRef('rul_1', names)?.link).toEqual({
      to: '/settings',
      search: { tab: 'policies' },
    });
    expect(auditRef('GITHUB_TOKEN', names)).toMatchObject({ text: 'GITHUB_TOKEN', link: null });
    expect(auditRef(null, names)).toBeNull();
  });

  it('shows actors as you, Orbit or a named Bot, and actions in words', () => {
    expect(auditActor('owner', names).text).toBe('you');
    expect(auditActor('system', names).text).toBe('Orbit');
    expect(auditActor('bot:bot_01abc', names)).toMatchObject({ text: 'Bot Mailer' });
    expect(auditActor('weird\u001b[31m', names).text).not.toContain('\u001b');
    expect(auditAction('policy.allowed_by_rule')).toBe('policy · allowed by rule');
    expect(auditAction('bot.created')).toBe('bot · created');
  });
});
