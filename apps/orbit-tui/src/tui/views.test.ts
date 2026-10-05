import { describe, expect, it } from 'vitest';
import { events } from '../../test/tui-fixtures';
import { timelineLines } from './views';

const plain = (_style: unknown, text: string) => text;

describe('timeline wording', () => {
  it('a call held for approval reads as a pause, not a denial', () => {
    const lines = timelineLines(
      events('run_1', 'bot_1', [
        {
          type: 'permission.decision',
          data: {
            toolUseId: 't1',
            toolName: 'mcp__gmail__send_email',
            input: {},
            behavior: 'deny',
            reason:
              "Waiting for your owner's approval (apr_1). Stop here; this run resumes automatically after the decision.",
            tier: 'EXTERNAL',
            ruleId: null,
            approvalId: 'apr_1',
          },
        },
        {
          type: 'permission.decision',
          data: {
            toolUseId: 't2',
            toolName: 'Bash',
            input: {},
            behavior: 'deny',
            reason: 'Your owner denied this',
            tier: 'EXTERNAL',
            ruleId: null,
            approvalId: 'apr_2',
          },
        },
      ]),
      plain,
    );
    expect(lines[0]).toMatch(/⏸ held for your approval \(apr_1\)/);
    expect(lines[1]).toMatch(/✗ denied — Your owner denied this/);
  });
});
