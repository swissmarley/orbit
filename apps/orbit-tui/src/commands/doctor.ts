import type { DoctorReport } from '@orbit/sdk-client';
import { ExitCode, defaultRedactor, formatWhen } from '@orbit/core';
import { hasOAuthTokenEnv } from '@orbit/runtime';
import type { Context } from '../context';
import { painter } from '../io';
import { clean } from './approvals';

export function doctorExitCode(r: Pick<DoctorReport, 'driver' | 'refusal'>): number {
  if (r.driver) return ExitCode.ok;
  return r.refusal?.code === 'compliance_refused'
    ? ExitCode.complianceRefused
    : ExitCode.authRequired;
}

/** Ask orbitd how it would run Bots (driver, auth, compliance, sandbox) and show it. */
export async function doctor(ctx: Context, opts: { json?: boolean }): Promise<number> {
  const r = await (await ctx.client()).doctor();
  // orbitd never receives CLAUDE_CODE_OAUTH_TOKEN; detect it here, by name only.
  const oauthTokenEnvPresent = hasOAuthTokenEnv(ctx.io.env);
  if (opts.json) {
    ctx.io.out(JSON.stringify({ ...r, oauthTokenEnvPresent }, null, 2));
    return doctorExitCode(r);
  }

  const p = painter(ctx.io);
  const row = (k: string, v: string) => ctx.io.out(`  ${p('dim', k.padEnd(12))} ${v}`);
  ctx.io.out(p('bold', 'Orbit doctor'));
  row(
    'Driver',
    r.driver
      ? `${p('bold', r.driver)} ${p('dim', `(${r.driverSource === 'forced' ? 'forced by ORBIT_DRIVER' : 'auto-detected'})`)}`
      : p('red', 'none'),
  );
  row('Auth', r.driver ? p('bold', r.authLabel) : p('red', r.authLabel));
  if (r.cli) {
    row(
      'claude CLI',
      `${r.cli.path} ${r.cli.version ?? ''} — ${r.cli.loggedIn ? p('green', `logged in (${r.cli.authMethod ?? 'unknown'})`) : p('yellow', 'not logged in')}`,
    );
  } else if (r.driver === 'mock' && r.driverSource === 'forced') {
    row('claude CLI', p('dim', 'not checked (ORBIT_DRIVER=mock)'));
  } else {
    row('claude CLI', p('dim', 'not found on PATH'));
  }
  row('API key', r.apiCredential ? p('bold', r.apiCredential) : p('dim', 'none configured'));
  row(
    'Mode',
    `${r.mode} · API bind ${r.api.host}:${r.api.port}${r.listen.container ? ' (inside a container)' : ''} · ${r.humanPrincipals} human principal${r.humanPrincipals === 1 ? '' : 's'}`,
  );
  if (r.hosted) {
    // Hosted mode (ADR-015): where browsers and webhooks arrive, who signs them in.
    const roles = (['owner', 'operator', 'viewer'] as const)
      .map((role) => `${r.principals[role]} ${role}${r.principals[role] === 1 ? '' : 's'}`)
      .join(', ');
    row(
      'Hosted',
      `${p('bold', r.hosted.publicUrl ?? 'no public URL')} · TLS ${r.hosted.tls ? 'in orbitd' : 'at your reverse proxy'}`,
    );
    row('Sign-in', `${r.hosted.issuer ?? p('red', 'no OIDC issuer')} · ${roles}`);
  }
  row(
    'Compliance',
    r.compliance.allowed
      ? p('green', 'subscription use allowed (local, single user)')
      : p('yellow', 'subscription use refused — API key required'),
  );
  row('Models', `default ${p('bold', r.models.default)} · triage ${p('bold', r.models.triage)}`);
  row(
    'Sandbox',
    [
      r.sandbox.engineSandbox.available
        ? p('green', 'engine sandbox available')
        : p(
            'yellow',
            `engine sandbox unavailable${r.sandbox.engineSandbox.missing.length ? ` (missing ${r.sandbox.engineSandbox.missing.join(', ')})` : ''} — shell commands need approval`,
          ),
      r.sandbox.docker.available
        ? `docker ${r.sandbox.docker.version ?? ''}`.trim()
        : p('dim', 'no docker'),
    ].join(' · '),
  );
  const ds = r.sandbox.dockerSandbox;
  row(
    'Docker Bots',
    ds.ready
      ? p('green', '✔ ready — the API key stays on the host (key proxy)')
      : `${p('yellow', '⚠ not ready')} — ${ds.detail}`,
  );
  for (const px of ds.proxies) {
    const refused = px.api.refused + (px.egress?.refused ?? 0);
    const last = [...px.api.recent, ...(px.egress?.recent ?? [])]
      .sort((a, b) => a.at.localeCompare(b.at))
      .at(-1);
    row(
      '',
      `${p('dim', px.botId)} network ${px.network} · ${px.activeRuns} active · ${refused} refused` +
        (last
          ? ` (last: ${clean(last.target)} — ${clean(last.reason)}, ${formatWhen(last.at)})`
          : ''),
    );
  }
  row(
    'Daemon',
    `orbitd ${r.daemon.url} · pid ${r.daemon.pid} · up since ${formatWhen(r.daemon.startedAt)} · ${r.daemon.concurrency} concurrent run${r.daemon.concurrency === 1 ? '' : 's'}`,
  );
  row('Data', r.home);
  row('Runtime', `node ${r.node} · ${r.platform}`);
  for (const w of r.warnings)
    ctx.io.out(`\n${p('yellow', '⚠')} ${defaultRedactor.redactString(w.message)}`);
  if (oauthTokenEnvPresent) {
    ctx.io.out(
      `\n${p('yellow', '⚠')} CLAUDE_CODE_OAUTH_TOKEN is set in this shell. Orbit never reads or forwards it; log in with \`claude auth login\` instead.`,
    );
  }
  if (r.refusal) ctx.io.out(`\n${p('red', '✘')} ${r.refusal.message}`);
  if (r.onboarding) {
    ctx.io.out(`\n${p('bold', 'Get started')} ${p('dim', `— ${r.onboarding.reason}`)}`);
    r.onboarding.steps.forEach((s, i) => ctx.io.out(`  ${i + 1}. ${s}`));
  }
  return doctorExitCode(r);
}
