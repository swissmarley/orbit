#!/usr/bin/env node
import { ExitCode, OrbitError, defaultRedactor, errorMessage } from '@orbit/core';
import { startDaemon } from './daemon';
import { receiveApiKey, reexecWithoutKey } from './key-handover';

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
  // ANTHROPIC_API_KEY in our own environment: re-execute without it (same
  // PID), the key travelling on a pipe. Returns only when that cannot be done.
  await reexecWithoutKey(log);
  // orbitd reads its own environment for credentials; children get allowlists.
  // A handed-over key lives only in this in-memory copy.
  const received = receiveApiKey(process.env);
  defaultRedactor.addSecret(received.env.ANTHROPIC_API_KEY);
  const daemon = await startDaemon({
    env: received.env,
    ...(received.handedOver ? { apiKeyOrigin: 'handed_over' as const } : {}),
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
