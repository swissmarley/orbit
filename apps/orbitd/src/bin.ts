#!/usr/bin/env node
import { ExitCode, OrbitError, defaultRedactor, errorMessage } from '@orbit/core';
import { startDaemon } from './daemon';

/**
 * `orbitd` — run the Orbit daemon in the foreground until SIGINT/SIGTERM or
 * `orbit daemon stop`. The CLI starts it in the background automatically.
 */
async function main(): Promise<void> {
  const log = (level: string, message: string) =>
    process.stderr.write(
      `${new Date().toISOString()} [orbitd] ${level}: ${defaultRedactor.redactString(message)}\n`,
    );
  let stopping = false;
  const daemon = await startDaemon({
    // orbitd reads its own environment for credentials; children get allowlists.
    env: process.env,
    log,
    onStopRequested: () => void shutdown('stop requested'),
  });
  log('info', `listening on ${daemon.url} (home ${daemon.config.home})`);

  async function shutdown(reason: string): Promise<void> {
    if (stopping) return;
    stopping = true;
    log('info', `stopping: ${reason}`);
    await daemon.stop();
    process.exit(ExitCode.ok);
  }
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err: unknown) => {
  const message = defaultRedactor.redactString(errorMessage(err));
  process.stderr.write(`orbitd: ${message}\n`);
  if (err instanceof OrbitError && err.hint) process.stderr.write(`${err.hint}\n`);
  process.exit(err instanceof OrbitError ? err.exitCode : ExitCode.error);
});
