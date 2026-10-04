import { OrbitError } from '@orbit/core';
import { defaultHome } from '@orbit/runtime';
import type { OrbitClient } from '@orbit/sdk-client';
import { runningDaemon, spawnDaemon, waitForDaemon } from './daemon-control';
import type { Io } from './io';

/**
 * Per-invocation state of the CLI. The CLI is a thin client of orbitd: it
 * finds the daemon of this ORBIT_HOME (starting it on loopback if needed,
 * unless ORBIT_NO_AUTOSTART=1) and talks to it only through
 * @orbit/sdk-client.
 */
export class Context {
  readonly home: string;
  private clientPromise: Promise<OrbitClient> | undefined;

  constructor(readonly io: Io) {
    this.home = defaultHome(io.env);
  }

  client(): Promise<OrbitClient> {
    this.clientPromise ??= this.connect();
    return this.clientPromise;
  }

  private async connect(): Promise<OrbitClient> {
    const running = await runningDaemon(this.home);
    if (running) return running;
    if (this.io.env.ORBIT_NO_AUTOSTART === '1') {
      throw new OrbitError('daemon_unavailable', 'orbitd is not running', {
        hint: 'Start it with `orbit daemon start` (or unset ORBIT_NO_AUTOSTART).',
      });
    }
    if (this.io.startDaemon) await this.io.startDaemon(this.io.env);
    else spawnDaemon(this.io.env);
    return waitForDaemon(this.home);
  }

  close(): void {
    this.clientPromise = undefined;
  }
}
