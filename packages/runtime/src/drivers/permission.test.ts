import { describe, expect, it } from 'vitest';
import { postHookOutput, postProcess } from './permission';

describe('post-processing hooks', () => {
  it('rewrites successful output for PostToolUse', () => {
    expect(postHookOutput({ updatedOutput: 'x', additionalContext: 'c' })).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        updatedToolOutput: 'x',
        additionalContext: 'c',
      },
    });
    expect(postHookOutput({})).toEqual({});
  });

  it('never offers a rewrite for failures (the engine has none); stop ends the engine', () => {
    expect(postHookOutput({ updatedOutput: 'x' }, 'PostToolUseFailure')).toEqual({});
    expect(postHookOutput({ stop: 'secret in error' }, 'PostToolUseFailure')).toEqual({
      continue: false,
      stopReason: 'secret in error',
    });
    expect(
      postHookOutput({ stop: 'halt', additionalContext: 'untrusted' }, 'PostToolUseFailure'),
    ).toEqual({
      continue: false,
      stopReason: 'halt',
      hookSpecificOutput: { hookEventName: 'PostToolUseFailure', additionalContext: 'untrusted' },
    });
  });

  it('fails closed when the result handler throws', async () => {
    const d = await postProcess(() => Promise.reject(new Error('boom')), {
      toolName: 'Read',
      toolUseId: 't',
      input: {},
      response: 'x',
    });
    expect(d.stop).toMatch(/could not post-process/);
    expect(
      await postProcess(undefined, { toolName: 'Read', toolUseId: 't', input: {}, response: 'x' }),
    ).toEqual({});
  });
});
