import { ONBOARDING_STEPS } from '@orbit/runtime';
import type { Io } from '../io';
import { painter } from '../io';

const COMPLIANCE_NOTE =
  'Subscription mode uses your own logged-in `claude` CLI and is limited to personal, local, single-user use: ' +
  'Orbit refuses it when bound to a network address, shared by several people, or run with ORBIT_MODE=hosted. ' +
  'Orbit never reads, stores or forwards your Claude login; only the official `claude` binary touches it.';

export function loginHelp(io: Io, opts: { json?: boolean }): number {
  if (opts.json) {
    io.out(JSON.stringify({ steps: ONBOARDING_STEPS, compliance: COMPLIANCE_NOTE }, null, 2));
    return 0;
  }
  const p = painter(io);
  io.out(p('bold', 'Connect Orbit to Claude'));
  ONBOARDING_STEPS.forEach((s, i) => io.out(`  ${i + 1}. ${s}`));
  io.out(`\n${p('dim', COMPLIANCE_NOTE)}`);
  io.out(`\nCheck the result with ${p('bold', 'orbit doctor')}.`);
  return 0;
}
