import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { hiddenQuestion } from './io';

describe('hidden credential prompt', () => {
  it('reads an edited credential without writing it to terminal output', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let shown = '';
    output.on('data', (chunk: Buffer) => {
      shown += chunk.toString();
    });
    const answer = hiddenQuestion('API key: ', input, output);
    input.write('sk-ant-secretX\u007f\r');
    expect(await answer).toBe('sk-ant-secret');
    expect(shown).toBe('API key: \n');
    input.end();
    output.end();
  });

  it('cancels on Ctrl-C without printing typed text', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let shown = '';
    output.on('data', (chunk: Buffer) => {
      shown += chunk.toString();
    });
    const answer = hiddenQuestion('API key: ', input, output);
    input.write('sk-ant-secret\u0003');
    await expect(answer).rejects.toThrow('Setup cancelled');
    expect(shown).not.toContain('sk-ant-secret');
    input.end();
    output.end();
  });
});
