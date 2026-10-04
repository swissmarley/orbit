import { Command, CommanderError } from 'commander';
import { ExitCode, OrbitError, defaultRedactor, errorMessage } from '@orbit/core';
import { botCreate, botList } from './commands/bot';
import { doctor } from './commands/doctor';
import { loginHelp } from './commands/login-help';
import { logs, runBot, runsList } from './commands/run';
import { Context } from './context';
import { type Io, painter } from './io';

export const VERSION = '0.1.0';

/** Build and run the CLI; resolves to the process exit code (only a second Ctrl-C force-exits). */
export async function main(argv: string[], io: Io): Promise<number> {
  let code: number = ExitCode.ok;
  let ctx: Context | undefined;
  const context = () => (ctx ??= new Context(io));
  const set = async (p: number | Promise<number>) => {
    code = await p;
  };

  const program = new Command()
    .name('orbit')
    .description('Orbit — always-on, goal-driven AI Bots powered by Claude Code')
    .version(VERSION)
    .exitOverride()
    .configureOutput({ writeOut: (s) => io.out(s.trimEnd()), writeErr: (s) => io.err(s.trimEnd()) })
    .showHelpAfterError();

  program
    .command('doctor')
    .description('Show the active driver, auth method, compliance status and configuration')
    .option('--json', 'machine-readable output')
    .action((o: { json?: boolean }) => set(doctor(context(), o)));

  program
    .command('login-help')
    .description('How to connect Orbit to Claude (subscription or API key)')
    .option('--json', 'machine-readable output')
    .action((o: { json?: boolean }) => set(loginHelp(io, o)));

  const bot = program.command('bot').description('Manage Bots');
  bot
    .command('create')
    .description('Create a Bot from flags or a YAML/JSON file')
    .option('-f, --file <path>', 'bot spec file (YAML or JSON)')
    .option('-n, --name <name>', 'bot name')
    .option('-g, --goal <goal>', 'what the bot works toward')
    .option('-i, --instructions <text>', 'standing instructions')
    .option('-m, --model <model>', 'model alias or ID (default: ORBIT_DEFAULT_MODEL)')
    .option('--tools <list>', 'comma-separated built-in tools to expose')
    .option('--max-turns <n>', 'turn limit per run')
    .option('--fixture <name>', 'mock scenario used in demo mode')
    .option('--json', 'machine-readable output')
    .action((o: Parameters<typeof botCreate>[1]) => set(botCreate(context(), o)));
  bot
    .command('list')
    .description('List Bots')
    .option('--json', 'machine-readable output')
    .action((o: { json?: boolean }) => set(botList(context(), o)));

  program
    .command('run')
    .description('Run a Bot now and stream its events')
    .argument('<bot>', 'bot name or id')
    .option('-p, --prompt <text>', 'task for this run (default: the bot goal)')
    .option('--fixture <name>', 'mock scenario (MockDriver only)')
    .option('--json', 'stream events as NDJSON')
    .action((botRef: string, o: { prompt?: string; fixture?: string; json?: boolean }) =>
      set(runBot(context(), botRef, o)),
    );

  program
    .command('runs')
    .description('List recent Runs')
    .option('-b, --bot <bot>', 'only runs of this bot')
    .option('-l, --limit <n>', 'how many', '20')
    .option('--json', 'machine-readable output')
    .action((o: { bot?: string; limit?: string; json?: boolean }) => set(runsList(context(), o)));

  program
    .command('logs')
    .description('Replay a Run from the event log')
    .argument('<run>', 'run id')
    .option('--json', 'NDJSON events')
    .action((runId: string, o: { json?: boolean }) => set(logs(context(), runId, o)));

  try {
    await program.parseAsync(argv, { from: 'user' });
  } catch (err) {
    if (err instanceof CommanderError) {
      code =
        err.code === 'commander.helpDisplayed' || err.code === 'commander.version'
          ? ExitCode.ok
          : ExitCode.usage;
    } else if (err instanceof OrbitError) {
      const p = painter(io);
      io.err(`${p('red', '✘')} ${defaultRedactor.redactString(err.message)}`);
      if (err.hint) io.err(p('dim', err.hint));
      code = err.exitCode;
    } else {
      io.err(`✘ ${defaultRedactor.redactString(errorMessage(err))}`);
      code = ExitCode.error;
    }
  } finally {
    ctx?.close();
  }
  return code;
}
