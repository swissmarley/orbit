import { Linter } from 'eslint';
import { describe, expect, it } from 'vitest';

/**
 * Positive controls for the lint rule that keeps process.env out of child
 * processes (ADR-005): the selectors configured in eslint.config.js, run on
 * snippets, must fire on every way of handing a child the whole environment
 * and stay quiet on an allowlist.
 */
// By URL: the config is plain JavaScript without type declarations.
const { envSelectors } = (await import(
  new URL('../../eslint.config.js', import.meta.url).href
)) as {
  envSelectors: { selector: string; message: string }[];
};

const linter = new Linter({ configType: 'flat' });
const lint = (code: string) =>
  linter
    .verify(code, [
      {
        languageOptions: { ecmaVersion: 2023, sourceType: 'module' },
        rules: { 'no-restricted-syntax': ['error', ...envSelectors] },
      },
    ])
    .filter((m) => m.message.includes('inherit process.env')).length;

describe('lint: child processes never get process.env wholesale', () => {
  it.each([
    ["spawn('pnpm', ['i'], { env: process.env })"],
    ["spawnSync('pnpm', ['build'], { cwd: root, stdio: 'inherit', env: process.env })"],
    ["cp.execFile('git', ['status'], { env: process.env }, () => {})"],
    ["execa('npm', ['pack'], { env: process.env })"],
    ["fork('worker.js', [], { env: process.env })"],
    ["spawn('x', [], { env: { ...process.env, A: '1' } })"],
  ])('flags %s', (code) => {
    expect(lint(code)).toBe(1);
  });

  it.each([
    ["spawn('x', [], { env: buildChildEnv('tool', process.env) })"],
    ["spawnSync('x', [], { env: toolEnv(process.env) })"],
    // Not a child process: a context object, a report.
    ['const ctx = { workspace: cwd, env: process.env };'],
    ['JSON.stringify({ args, env: process.env })'],
  ])('allows %s', (code) => {
    expect(lint(code)).toBe(0);
  });
});
