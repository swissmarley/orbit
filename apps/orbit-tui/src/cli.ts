import { Command, CommanderError } from 'commander';
import { ExitCode, OrbitError, defaultRedactor, errorMessage } from '@orbit/core';
import { openApp } from './commands/app';
import { botCreate, botList } from './commands/bot';
import { doctor } from './commands/doctor';
import { loginHelp } from './commands/login-help';
import { approvalShow, approvalsList, approve, deny } from './commands/approvals';
import { auditExport, auditList, auditVerify } from './commands/audit';
import { killSwitch, pauseBot, stopRun } from './commands/controls';
import { daemonStart, daemonStatus, daemonStop } from './commands/daemon';
import {
  feedbackCmd,
  memoryAdd,
  memoryEdit,
  memoryList,
  memoryRm,
  memoryShow,
  treeCmd,
  triageCmd,
} from './commands/memory';
import { rulesAdd, rulesList, rulesRevoke } from './commands/rules';
import { completion } from './commands/completion';
import {
  botLogs,
  logs,
  queueShow,
  resumeRun,
  runBot,
  runsList,
  schedulesShow,
  tail,
} from './commands/run';
import {
  pluginAdd,
  pluginCheck,
  pluginDisable,
  pluginEnable,
  pluginRemove,
  pluginSecret,
  pluginSetting,
  pluginShow,
  pluginsList,
  templatesList,
  triggersList,
  webhookSecret,
} from './commands/plugins';
import { secretList, secretRemove, secretSet } from './commands/secrets';
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
    // Options after a subcommand belong to it (`orbit audit verify --json`).
    .enablePositionalOptions()
    .configureOutput({ writeOut: (s) => io.out(s.trimEnd()), writeErr: (s) => io.err(s.trimEnd()) })
    .showHelpAfterError();

  program
    .command('tui', { isDefault: false })
    .description('Full-screen terminal UI: Bots, live timeline, approvals (also `orbit` alone)')
    .action(async () => {
      // Ink's colour library ignores NO_COLOR: decide before it loads.
      if (!io.color) process.env.FORCE_COLOR = '0';
      const { runTui } = await import('./tui');
      await set(runTui(context()));
    });

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
    .option('-t, --template <id>', 'start from a template, e.g. inbox-triage (see orbit templates)')
    .option('--plugins <list>', 'comma-separated plugin ids the Bot may use (see orbit plugins)')
    .option('-n, --name <name>', 'bot name')
    .option('-g, --goal <goal>', 'what the bot works toward')
    .option('-i, --instructions <text>', 'standing instructions')
    .option('-m, --model <model>', 'model alias or ID (default: ORBIT_DEFAULT_MODEL)')
    .option('--tools <list>', 'comma-separated built-in tools to expose')
    .option('--max-turns <n>', 'turn limit per run')
    .option('--fixture <name>', 'mock scenario used in demo mode')
    .option('--cron <expr>', 'run on a schedule, e.g. "0 9 * * 1-5" (daemon local time)')
    .option('--every <minutes>', 'run every N minutes')
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
    .command('queue')
    .description('What orbitd is running and what waits (concurrency, priority, usage-limit hold)')
    .option('--json', 'machine-readable output')
    .action((o: { json?: boolean }) => set(queueShow(context(), o)));

  program
    .command('schedules')
    .description('Scheduled triggers and when they fire next')
    .option('-b, --bot <bot>', 'only this bot')
    .option('--json', 'machine-readable output')
    .action((o: { bot?: string; json?: boolean }) => set(schedulesShow(context(), o)));

  const daemon = program
    .command('daemon')
    .description('The orbitd daemon (started automatically on first use)');
  daemon
    .command('start')
    .description('Start orbitd in the background (loopback only)')
    .option('--json', 'machine-readable output')
    .action((o: { json?: boolean }) => set(daemonStart(context(), o)));
  daemon
    .command('stop')
    .description('Stop orbitd gracefully')
    .option('--json', 'machine-readable output')
    .action((o: { json?: boolean }) => set(daemonStop(context(), o)));
  daemon
    .command('status')
    .description('Is orbitd running? Where, since when, with what queue')
    .option('--json', 'machine-readable output')
    .action((o: { json?: boolean }) => set(daemonStatus(context(), o)));
  daemon
    .command('restart')
    .description('Stop and start orbitd (picks up a changed environment, e.g. a new API key)')
    .option('--json', 'machine-readable output')
    .action(async (o: { json?: boolean }) => {
      const ctx = context();
      await daemonStop(ctx, { json: true });
      ctx.close();
      if (!o.json) io.out('Restarting orbitd…');
      await set(daemonStart(ctx, o));
    });

  program
    .command('logs')
    .description('Replay a Run from the event log')
    .argument('<run>', 'run id')
    .option('--json', 'NDJSON events')
    .action((runId: string, o: { json?: boolean }) => set(logs(context(), runId, o)));

  bot
    .command('pause')
    .description('Kill switch for one Bot: stop its Runs and block new ones')
    .argument('<bot>')
    .option('--json', 'machine-readable output')
    .action((b: string, o: { json?: boolean }) => set(pauseBot(context(), b, true, o)));
  bot
    .command('resume')
    .description('Allow a paused Bot to run again')
    .argument('<bot>')
    .option('--json', 'machine-readable output')
    .action((b: string, o: { json?: boolean }) => set(pauseBot(context(), b, false, o)));

  program
    .command('resume')
    .description('Resume a parked (approvals decided) or rate-limited Run')
    .argument('<run>', 'run id')
    .option('--fixture <name>', 'mock scenario (MockDriver only)')
    .option('--json', 'stream events as NDJSON')
    .action((runId: string, o: { json?: boolean; fixture?: string }) =>
      set(resumeRun(context(), runId, o)),
    );

  program
    .command('stop')
    .description('Kill switch for one Run (works from any terminal)')
    .argument('<run>', 'run id')
    .option('--json', 'machine-readable output')
    .action((runId: string, o: { json?: boolean }) => set(stopRun(context(), runId, o)));

  program
    .command('kill')
    .description('Global kill switch: stop every Run and refuse new ones')
    .option('--off', 'release the kill switch')
    .option('--status', 'show whether it is engaged')
    .option('--json', 'machine-readable output')
    .action((o: { off?: boolean; status?: boolean; json?: boolean }) =>
      set(killSwitch(context(), o)),
    );

  const approvals = program
    .command('approvals')
    .description('What needs you: pending approval cards')
    .option('-a, --all', 'include decided approvals')
    .option('--json', 'machine-readable output')
    .action((o: { all?: boolean; json?: boolean }) => set(approvalsList(context(), o)));
  approvals
    .command('show')
    .argument('<id>', 'approval id')
    .option('--json', 'machine-readable output')
    .action((id: string, o: { json?: boolean }) => set(approvalShow(context(), id, o)));

  program
    .command('approve')
    .description('Approve a pending action (optionally edited, optionally always)')
    .argument('<id>', 'approval id')
    .option('-e, --edit <json|@file>', 'approve this edited tool input instead')
    .option('--always', 'also create a standing allow rule for this tool')
    .option('--global', 'with --always: for every Bot, not just this one')
    .option(
      '--expires <duration>',
      'with --always: rule expiry, e.g. 30m, 7d or never (default 7d)',
    )
    .option('--no-resume', 'do not resume the parked Run now')
    .option('--fixture <name>', 'mock scenario for the resumed Run (MockDriver only)')
    .option('--json', 'machine-readable output')
    .action((id: string, o: Parameters<typeof approve>[2]) => set(approve(context(), id, o)));

  program
    .command('deny')
    .description('Deny a pending action, with a reason the Bot will see')
    .argument('<id>', 'approval id')
    .option('-r, --reason <text>', 'why (shown to the Bot)')
    .option('--no-resume', 'do not resume the parked Run now')
    .option('--fixture <name>', 'mock scenario for the resumed Run (MockDriver only)')
    .option('--json', 'machine-readable output')
    .action((id: string, o: Parameters<typeof deny>[2]) => set(deny(context(), id, o)));

  const rules = program
    .command('rules')
    .description('Standing allow/deny rules (user-authored only)');
  rules
    .command('list')
    .option('-a, --all', 'include revoked and expired rules')
    .option('--json', 'machine-readable output')
    .action((o: { all?: boolean; json?: boolean }) => set(rulesList(context(), o)));
  rules
    .command('add')
    .requiredOption('-t, --tool <pattern>', 'tool name or glob, e.g. mcp__slack__post_message')
    .requiredOption('--effect <allow|deny>', 'allow or deny')
    .option('-b, --bot <bot>', 'only for this Bot (default: all Bots)')
    .option('--expires <duration>', 'e.g. 7d or never (allow rules default to 7d)')
    .option('-r, --reason <text>', 'why')
    .option(
      '-m, --match <field=glob>',
      "only when a top-level argument matches (repeatable; * is one value), e.g. 'to=*@example.com'",
      (v: string, prev: string[] | undefined) => [...(prev ?? []), v],
    )
    .option('--json', 'machine-readable output')
    .action((o: Parameters<typeof rulesAdd>[1]) => set(rulesAdd(context(), o)));
  rules
    .command('revoke')
    .argument('<id>', 'rule id')
    .option('--json', 'machine-readable output')
    .action((id: string, o: { json?: boolean }) => set(rulesRevoke(context(), id, o)));

  const audit = program
    .command('audit')
    .description('Tamper-evident audit log')
    .option('--action <action>', 'filter by action, e.g. approval.decided')
    .option('-l, --limit <n>', 'how many (latest)', '50')
    .option('--json', 'machine-readable output')
    .action((o: { action?: string; limit?: string; json?: boolean }) =>
      set(auditList(context(), o)),
    );
  audit
    .command('verify')
    .description('Check the hash chain')
    .option('--json', 'machine-readable output')
    .action((o: { json?: boolean }) => set(auditVerify(context(), o)));
  audit
    .command('export')
    .description('Export as JSONL')
    .option('-o, --out <file>', 'write to a file (mode 0600) instead of stdout')
    .action((o: { out?: string }) => set(auditExport(context(), o)));

  const secret = program
    .command('secret')
    .description('Encrypted secrets vault (values never shown)');
  secret
    .command('set')
    .argument('<name>', 'env-style name, e.g. GITHUB_TOKEN')
    .option('--value-file <path>', 'read the value from a file (default: stdin)')
    .option('--json', 'machine-readable output')
    .action((name: string, o: { valueFile?: string; json?: boolean }) =>
      set(secretSet(context(), name, o)),
    );
  secret
    .command('list')
    .option('--json', 'machine-readable output')
    .action((o: { json?: boolean }) => set(secretList(context(), o)));
  secret
    .command('rm')
    .argument('<name>')
    .option('--json', 'machine-readable output')
    .action((name: string, o: { json?: boolean }) => set(secretRemove(context(), name, o)));

  program
    .command('plugins')
    .description('Plugins (MCP servers Orbit runs for Bots) and their state')
    .option('--json', 'machine-readable output')
    .action((o: { json?: boolean }) => set(pluginsList(context(), o)));
  const plugin = program
    .command('plugin')
    .description('Show, enable and set up a plugin (Settings → Integrations in the App)');
  plugin
    .command('show')
    .argument('<id>', 'plugin id, e.g. github')
    .option('--json', 'machine-readable output')
    .action((id: string, o: { json?: boolean }) => set(pluginShow(context(), id, o)));
  plugin
    .command('enable')
    .description('Start it once to list its tools, then offer it to the Bots that list it')
    .argument('<id>')
    .option('--json', 'machine-readable output')
    .action((id: string, o: { json?: boolean }) => set(pluginEnable(context(), id, o)));
  plugin
    .command('disable')
    .argument('<id>')
    .option('--json', 'machine-readable output')
    .action((id: string, o: { json?: boolean }) => set(pluginDisable(context(), id, o)));
  plugin
    .command('check')
    .description('Start it once and list its tools (does not enable it)')
    .argument('<id>')
    .option('--json', 'machine-readable output')
    .action((id: string, o: { json?: boolean }) => set(pluginCheck(context(), id, o)));
  plugin
    .command('add')
    .description(
      'Add a plugin from a directory with an orbit-plugin.json (stays off until enabled)',
    )
    .argument('<dir>')
    .option('--json', 'machine-readable output')
    .action((dir: string, o: { json?: boolean }) => set(pluginAdd(context(), dir, o)));
  plugin
    .command('rm')
    .description('Forget a plugin you added, and its secrets')
    .argument('<id>')
    .option('--json', 'machine-readable output')
    .action((id: string, o: { json?: boolean }) => set(pluginRemove(context(), id, o)));
  plugin
    .command('secret')
    .description("Store one of the plugin's secrets (value from --value-file or stdin, never argv)")
    .argument('<id>')
    .argument('<name>', 'the secret name the plugin declares, e.g. GITHUB_TOKEN')
    .option('--value-file <path>', 'read the value from a file (default: stdin)')
    .option('--remove', 'remove it instead')
    .option('--json', 'machine-readable output')
    .action(
      (id: string, name: string, o: { valueFile?: string; remove?: boolean; json?: boolean }) =>
        set(pluginSecret(context(), id, name, o)),
    );
  plugin
    .command('setting')
    .description('Set a non-secret plugin setting (e.g. FS_ROOTS, BROWSER_ALLOWED_DOMAINS)')
    .argument('<id>')
    .argument('<name>')
    .argument('[value]')
    .option('--clear', 'clear it')
    .option('--json', 'machine-readable output')
    .action(
      (
        id: string,
        name: string,
        value: string | undefined,
        o: { clear?: boolean; json?: boolean },
      ) => set(pluginSetting(context(), id, name, value, o)),
    );
  program
    .command('triggers')
    .description('Inbound triggers (webhooks, Slack, files, git) and whether they listen')
    .option('--json', 'machine-readable output')
    .action((o: { json?: boolean }) => set(triggersList(context(), o)));
  const trigger = program.command('trigger').description('Set up inbound triggers');
  trigger
    .command('webhook-secret')
    .description("Mint (or rotate) a webhook trigger's signing secret; shown once")
    .argument('<bot>', 'bot name or id')
    .argument('<name>', 'the webhook trigger name')
    .option('--json', 'machine-readable output')
    .action((botRef: string, name: string, o: { json?: boolean }) =>
      set(webhookSecret(context(), botRef, name, o)),
    );
  program
    .command('templates')
    .description('Ready-made Bots (orbit bot create --template <id>)')
    .option('--json', 'machine-readable output')
    .action((o: { json?: boolean }) => set(Promise.resolve(templatesList(context(), o))));

  program
    .command('tail')
    .description('Follow a Run live until it ends (Ctrl-C detaches; the Run keeps going)')
    .argument('<run>', 'run id')
    .option('--segment', 'stop at the end of the current segment (park, usage limit)')
    .option('--json', 'stream events as NDJSON')
    .action((runId: string, o: { json?: boolean; segment?: boolean }) =>
      set(tail(context(), runId, o)),
    );

  bot
    .command('run')
    .description('Run a Bot now and stream its events (same as `orbit run`)')
    .argument('<bot>', 'bot name or id')
    .option('-p, --prompt <text>', 'task for this run (default: the bot goal)')
    .option('--fixture <name>', 'mock scenario (MockDriver only)')
    .option('--json', 'stream events as NDJSON')
    .action((botRef: string, o: { prompt?: string; fixture?: string; json?: boolean }) =>
      set(runBot(context(), botRef, o)),
    );
  bot
    .command('logs')
    .description("Replay the Bot's newest Run")
    .argument('<bot>', 'bot name or id')
    .option('--json', 'NDJSON events')
    .action((b: string, o: { json?: boolean }) => set(botLogs(context(), b, o)));

  program
    .command('app')
    .description('Open the Orbit App in your browser (one-time sign-in link)')
    .option('--origin <url>', 'App origin when not served by orbitd (e.g. the Vite dev server)')
    .option('--no-open', 'print the link instead of opening a browser')
    .option('--json', 'machine-readable output ({ url, expiresAt })')
    .action((o: { origin?: string; open?: boolean; json?: boolean }) => set(openApp(context(), o)));

  const memory = program
    .command('memory')
    .description('What Bots remember: notes, run summaries and your feedback (with provenance)');
  memory
    .command('list')
    .description('Memories of one Bot (or all), newest first')
    .argument('[bot]', 'bot name or id')
    .option('-s, --search <words>', 'full-text search')
    .option('-k, --kind <kind>', 'note, summary, feedback or fact')
    .option('-l, --limit <n>', 'how many', '50')
    .option('--json', 'machine-readable output')
    .action((b: string | undefined, o: Parameters<typeof memoryList>[2]) =>
      set(memoryList(context(), b, o)),
    );
  memory
    .command('show')
    .argument('<id>', 'memory id')
    .option('--json', 'machine-readable output')
    .action((id: string, o: { json?: boolean }) => set(memoryShow(context(), id, o)));
  memory
    .command('add')
    .description('Write a memory for a Bot (body from stdin or --body-file)')
    .argument('<bot>', 'bot name or id')
    .requiredOption('-t, --title <title>', 'short title')
    .option('--body-file <path>', 'read the body from a file (default: stdin)')
    .option('--pin', 'always offer it to new Runs')
    .option('--json', 'machine-readable output')
    .action((b: string, o: Parameters<typeof memoryAdd>[2]) => set(memoryAdd(context(), b, o)));
  memory
    .command('edit')
    .description('Edit a memory; --trust marks an untrusted one as reviewed')
    .argument('<id>', 'memory id')
    .option('-t, --title <title>', 'new title')
    .option('--body', 'replace the body with stdin')
    .option('--body-file <path>', 'replace the body with this file')
    .option('--pin', 'pin it')
    .option('--unpin', 'unpin it')
    .option('--trust', 'you reviewed it: clear its taint (audited)')
    .option('--json', 'machine-readable output')
    .action((id: string, o: Parameters<typeof memoryEdit>[2]) => set(memoryEdit(context(), id, o)));
  memory
    .command('rm')
    .argument('<id>', 'memory id')
    .option('--json', 'machine-readable output')
    .action((id: string, o: { json?: boolean }) => set(memoryRm(context(), id, o)));

  program
    .command('feedback')
    .description('Rate a finished Run: orbit feedback <run> up|down [--comment …]')
    .argument('<run>', 'run id')
    .argument('<rating>', 'up or down')
    .option('-c, --comment <text>', 'what was good or bad (the Bot sees it next time)')
    .option('--json', 'machine-readable output')
    .action((runId: string, rating: string, o: { comment?: string; json?: boolean }) =>
      set(feedbackCmd(context(), runId, rating, o)),
    );

  program
    .command('tree')
    .description('The delegation tree a Run belongs to (Bots handing work to Bots)')
    .argument('<run>', 'run id')
    .option('--json', 'machine-readable output')
    .action((runId: string, o: { json?: boolean }) => set(treeCmd(context(), runId, o)));

  program
    .command('triage')
    .description('Triage-model calls today (summaries, proposals) against the daily limit')
    .option('--json', 'machine-readable output')
    .action((o: { json?: boolean }) => set(triageCmd(context(), o)));

  program
    .command('completion')
    .description('Shell completion script: orbit completion bash|zsh|fish')
    .argument('<shell>', 'bash, zsh or fish')
    .action((shell: string) => set(completion(io, program, shell)));

  try {
    // `orbit` alone in a terminal opens the TUI; elsewhere it prints help.
    if (argv.length === 0 && io.interactive) argv = ['tui'];
    await program.parseAsync(argv, { from: 'user' });
  } catch (err) {
    if (err instanceof CommanderError) {
      code =
        err.code === 'commander.helpDisplayed' || err.code === 'commander.version'
          ? ExitCode.ok
          : ExitCode.usage;
    } else if (err instanceof OrbitError) {
      const p = painter(io);
      const message = defaultRedactor.redactString(err.message);
      const hint = err.hint ? defaultRedactor.redactString(err.hint) : null;
      // --json callers get a machine-readable error on stdout too.
      if (argv.includes('--json')) {
        io.out(JSON.stringify({ error: { code: err.code, message, hint } }));
      }
      io.err(`${p('red', '✘')} ${message}`);
      if (hint) io.err(p('dim', hint));
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
