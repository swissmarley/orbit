#!/usr/bin/env node
// Fake `claude` executable for CliDriver tests. Behaviour is configured by
// `.fake-claude.json` in its working directory (the env is allowlisted by the
// driver, so env vars cannot be used to configure it). It records the argv,
// env and stdin it received to `.fake-claude-record.json` for assertions, and
// runs the real PreToolUse hook command from `--settings` for every tool call.
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readFixture, replay } from './fake-engine.mjs';

const cwd = process.cwd();
const control = JSON.parse(readFileSync(join(cwd, '.fake-claude.json'), 'utf8'));
const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

let stdin = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) stdin += chunk;

writeFileSync(
  join(cwd, '.fake-claude-record.json'),
  JSON.stringify({ args, env: process.env, stdin }),
);

const out = (m) => process.stdout.write(JSON.stringify(m) + '\n');
const sessionId = flag('--resume') ?? flag('--session-id');

if (control.behavior === 'crash') {
  out({
    type: 'system',
    subtype: 'init',
    session_id: sessionId ?? 's-crash',
    tools: [],
    model: 'm',
  });
  process.stderr.write('boom: something exploded\n');
  process.exit(3);
}
if (control.behavior === 'hang') {
  out({
    type: 'system',
    subtype: 'init',
    session_id: sessionId ?? 's-hang',
    tools: [],
    model: 'm',
  });
  setInterval(() => undefined, 1000);
} else {
  if (control.behavior === 'garbage') process.stdout.write('this is not json\n');
  const settings = JSON.parse(flag('--settings'));
  const command = settings.hooks.PreToolUse[0].hooks[0].command;

  const runHook = (input) =>
    new Promise((resolve) => {
      const child = spawn(command, {
        shell: true,
        env: process.env,
        stdio: ['pipe', 'pipe', 'inherit'],
      });
      let buf = '';
      child.stdout.on('data', (c) => (buf += c));
      child.on('close', () => {
        try {
          resolve(JSON.parse(buf));
        } catch {
          resolve(null);
        }
      });
      child.stdin.end(JSON.stringify(input));
    });

  for await (const m of replay(readFixture(control.fixture), { decide: runHook, sessionId, cwd })) {
    out(m);
  }
}
