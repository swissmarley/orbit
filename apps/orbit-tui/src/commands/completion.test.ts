import { Command } from 'commander';
import { describe, expect, it } from 'vitest';
import { completionTree } from './completion';

describe('completion name guard (names end up inside shell quotes)', () => {
  it('accepts plain command and option names', () => {
    const p = new Command('orbit');
    p.command('bot-run').option('--json');
    expect(completionTree(p).children[0]?.name).toBe('bot-run');
  });

  it('positive control: refuses names that could break out of shell quotes', () => {
    const evil = new Command('orbit');
    evil.command("x';rm -rf ~;'");
    expect(() => completionTree(evil)).toThrow(/Unsafe command name/);
    const evilOption = new Command('orbit');
    evilOption.command('ok').option('--a$(id)');
    expect(() => completionTree(evilOption)).toThrow(/Unsafe option/);
  });
});
