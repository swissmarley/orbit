import { arch, platform } from 'node:os';
import { ExitCode, defaultRedactor, humanPrincipalCount } from '@orbit/core';
import { type SandboxSupport, defaultRunner, detectSandboxSupport } from '@orbit/sandbox';
import { type AuthResolution, buildChildEnv, hasOAuthTokenEnv } from '@orbit/runtime';
import type { Context } from '../context';
import { painter } from '../io';

export interface DoctorReport {
  ok: boolean;
  driver: AuthResolution['driver'];
  driverSource: AuthResolution['source'];
  authMethod: AuthResolution['authMethod'];
  authLabel: string;
  cli: AuthResolution['cli'];
  apiCredential: AuthResolution['apiCredential'];
  oauthTokenEnvPresent: boolean;
  compliance: AuthResolution['guard'];
  warnings: AuthResolution['warnings'];
  refusal: AuthResolution['refusal'];
  onboarding: AuthResolution['onboarding'];
  mode: string;
  api: { host: string; port: number };
  humanPrincipals: number;
  models: { default: string; triage: string };
  home: string;
  node: string;
  platform: string;
  sandbox: SandboxSupport;
}

export function doctorExitCode(r: AuthResolution): number {
  if (r.driver) return ExitCode.ok;
  return r.refusal?.code === 'compliance_refused'
    ? ExitCode.complianceRefused
    : ExitCode.authRequired;
}

export async function doctor(ctx: Context, opts: { json?: boolean }): Promise<number> {
  const [r, sandbox] = await Promise.all([
    ctx.resolveAuth(),
    detectSandboxSupport(defaultRunner(buildChildEnv('tool', ctx.io.env)), {
      pathEnv: ctx.io.env.PATH ?? '',
    }),
  ]);
  const c = ctx.config;
  const report: DoctorReport = {
    ok: r.driver !== null,
    driver: r.driver,
    driverSource: r.source,
    authMethod: r.authMethod,
    authLabel: r.label,
    cli: r.cli
      ? { ...r.cli, error: r.cli.error ? defaultRedactor.redactString(r.cli.error) : null }
      : null,
    apiCredential: r.apiCredential,
    oauthTokenEnvPresent: hasOAuthTokenEnv(ctx.io.env),
    compliance: r.guard,
    warnings: r.warnings,
    refusal: r.refusal,
    onboarding: r.onboarding,
    mode: c.mode,
    api: c.api,
    humanPrincipals: humanPrincipalCount(c),
    models: c.models,
    home: c.home,
    node: process.version,
    platform: `${platform()}-${arch()}`,
    sandbox,
  };
  if (opts.json) {
    ctx.io.out(JSON.stringify(report, null, 2));
    return doctorExitCode(r);
  }

  const p = painter(ctx.io);
  const row = (k: string, v: string) => ctx.io.out(`  ${p('dim', k.padEnd(12))} ${v}`);
  ctx.io.out(p('bold', 'Orbit doctor'));
  row(
    'Driver',
    r.driver
      ? `${p('bold', r.driver)} ${p('dim', `(${r.source === 'forced' ? 'forced by ORBIT_DRIVER' : 'auto-detected'})`)}`
      : p('red', 'none'),
  );
  row('Auth', r.driver ? p('bold', r.label) : p('red', r.label));
  if (r.cli) {
    row(
      'claude CLI',
      `${r.cli.path} ${r.cli.version ?? ''} — ${r.cli.loggedIn ? p('green', `logged in (${r.cli.authMethod ?? 'unknown'})`) : p('yellow', 'not logged in')}`,
    );
  } else if (r.driver === 'mock' && r.source === 'forced') {
    row('claude CLI', p('dim', 'not checked (ORBIT_DRIVER=mock)'));
  } else {
    row('claude CLI', p('dim', 'not found on PATH'));
  }
  row('API key', r.apiCredential ? p('bold', r.apiCredential) : p('dim', 'none configured'));
  row(
    'Mode',
    `${c.mode} · API bind ${c.api.host}:${c.api.port} · ${report.humanPrincipals} human principal${report.humanPrincipals === 1 ? '' : 's'}`,
  );
  row(
    'Compliance',
    r.guard.allowed
      ? p('green', 'subscription use allowed (local, single user)')
      : p('yellow', 'subscription use refused — API key required'),
  );
  row('Models', `default ${p('bold', c.models.default)} · triage ${p('bold', c.models.triage)}`);
  row(
    'Sandbox',
    [
      sandbox.engineSandbox.available
        ? p('green', 'engine sandbox available')
        : p(
            'yellow',
            `engine sandbox unavailable${sandbox.engineSandbox.missing.length ? ` (missing ${sandbox.engineSandbox.missing.join(', ')})` : ''} — shell commands need approval`,
          ),
      sandbox.docker.available
        ? `docker ${sandbox.docker.version ?? ''}`.trim()
        : p('dim', 'no docker'),
    ].join(' · '),
  );
  row('Data', c.home);
  row('Runtime', `node ${process.version} · ${report.platform}`);
  for (const w of r.warnings)
    ctx.io.out(`\n${p('yellow', '⚠')} ${defaultRedactor.redactString(w.message)}`);
  if (r.refusal) {
    ctx.io.out(`\n${p('red', '✘')} ${r.refusal.message}`);
  }
  if (r.onboarding) {
    ctx.io.out(`\n${p('bold', 'Get started')} ${p('dim', `— ${r.onboarding.reason}`)}`);
    r.onboarding.steps.forEach((s, i) => ctx.io.out(`  ${i + 1}. ${s}`));
  }
  return doctorExitCode(r);
}
