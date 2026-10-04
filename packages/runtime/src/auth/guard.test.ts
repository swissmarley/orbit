import { ExitCode, OrbitConfig, type OrbitConfigInput, OrbitError } from '@orbit/core';
import { describe, expect, it } from 'vitest';
import {
  GUARD_API_KEY_HOWTO,
  type GuardViolation,
  assertCliDriverAllowed,
  checkCliDriverAllowed,
} from './guard';

const config = (input: Partial<OrbitConfigInput> = {}): OrbitConfig =>
  OrbitConfig.parse({ home: '/tmp/x', ...input });

const twoHumans = [
  { id: 'alice', kind: 'human' as const },
  { id: 'bob', kind: 'human' as const },
];
const threeHumans = [...twoHumans, { id: 'carol', kind: 'human' as const }];

const REASON: Record<GuardViolation, RegExp> = {
  hosted_mode: /ORBIT_MODE=hosted is set/,
  non_loopback_bind: /the API is bound to \S+, which is not a loopback address/,
  multiple_principals: /\d+ human principals are configured/,
};

interface Row {
  name: string;
  config: Partial<OrbitConfigInput>;
  violations: GuardViolation[];
  /** Extra text the message must contain (e.g. the actual host or count). */
  mentions?: string[];
}

const rows: Row[] = [
  // Allowed: local, loopback, one human.
  { name: 'defaults: local, 127.0.0.1, one owner → allowed', config: {}, violations: [] },
  { name: 'bound to localhost → allowed', config: { api: { host: 'localhost' } }, violations: [] },
  { name: 'bound to ::1 → allowed', config: { api: { host: '::1' } }, violations: [] },
  { name: 'bound to 127.0.0.2 → allowed', config: { api: { host: '127.0.0.2' } }, violations: [] },
  {
    name: 'one human + one service principal → allowed',
    config: {
      principals: [
        { id: 'owner', kind: 'human' },
        { id: 'ci', kind: 'service' },
      ],
    },
    violations: [],
  },
  {
    name: 'only service principals (no humans) → allowed',
    config: { principals: [{ id: 'ci', kind: 'service' }] },
    violations: [],
  },
  { name: 'explicit ORBIT_MODE=local → allowed', config: { mode: 'local' }, violations: [] },

  // Each violation alone.
  { name: 'ORBIT_MODE=hosted alone', config: { mode: 'hosted' }, violations: ['hosted_mode'] },
  {
    name: 'bound to 0.0.0.0 alone',
    config: { api: { host: '0.0.0.0' } },
    violations: ['non_loopback_bind'],
    mentions: ['0.0.0.0'],
  },
  {
    name: 'bound to :: (all IPv6 interfaces) alone',
    config: { api: { host: '::' } },
    violations: ['non_loopback_bind'],
    mentions: ['::'],
  },
  {
    name: 'bound to a LAN address alone',
    config: { api: { host: '192.168.1.10' } },
    violations: ['non_loopback_bind'],
    mentions: ['192.168.1.10'],
  },
  {
    name: 'bound to a public hostname alone',
    config: { api: { host: 'orbit.example.com' } },
    violations: ['non_loopback_bind'],
    mentions: ['orbit.example.com'],
  },
  {
    name: 'two human principals alone',
    config: { principals: twoHumans },
    violations: ['multiple_principals'],
    mentions: ['2 human principals'],
  },
  {
    name: 'three humans + a service principal alone',
    config: { principals: [...threeHumans, { id: 'ci', kind: 'service' }] },
    violations: ['multiple_principals'],
    mentions: ['3 human principals'],
  },

  // Combinations.
  {
    name: 'hosted + 0.0.0.0',
    config: { mode: 'hosted', api: { host: '0.0.0.0' } },
    violations: ['hosted_mode', 'non_loopback_bind'],
  },
  {
    name: 'hosted + two humans',
    config: { mode: 'hosted', principals: twoHumans },
    violations: ['hosted_mode', 'multiple_principals'],
  },
  {
    name: '0.0.0.0 + two humans',
    config: { api: { host: '0.0.0.0' }, principals: twoHumans },
    violations: ['non_loopback_bind', 'multiple_principals'],
  },
  {
    name: 'hosted + 0.0.0.0 + three humans (everything wrong)',
    config: { mode: 'hosted', api: { host: '0.0.0.0' }, principals: threeHumans },
    violations: ['hosted_mode', 'non_loopback_bind', 'multiple_principals'],
    mentions: ['0.0.0.0', '3 human principals'],
  },
];

describe('checkCliDriverAllowed', () => {
  it.each(rows)('$name', (row) => {
    const r = checkCliDriverAllowed(config(row.config));
    expect(r.violations).toEqual(row.violations);
    expect(r.allowed).toBe(row.violations.length === 0);

    if (row.violations.length === 0) {
      expect(r.message).toBeNull();
      return;
    }
    const message = r.message ?? '';
    expect(message).toMatch(/^Refusing to use your Claude subscription \(CliDriver\): /);
    // Explains *why* the restriction exists.
    expect(message).toMatch(/personal, local, single-user use/);
    expect(message).toMatch(/Anthropic does not allow third-party products/);
    // Every violation, and only those, is named.
    for (const v of Object.keys(REASON) as GuardViolation[]) {
      if (row.violations.includes(v)) expect(message).toMatch(REASON[v]);
      else expect(message).not.toMatch(REASON[v]);
    }
    for (const m of row.mentions ?? []) expect(message).toContain(m);
  });
});

describe('assertCliDriverAllowed', () => {
  it.each(rows.filter((r) => r.violations.length === 0))('$name → does not throw', (row) => {
    expect(() => {
      assertCliDriverAllowed(config(row.config));
    }).not.toThrow();
  });

  it.each(rows.filter((r) => r.violations.length > 0))(
    '$name → throws OrbitError(compliance_refused) with an API-key hint',
    (row) => {
      const cfg = config(row.config);
      let caught: unknown;
      try {
        assertCliDriverAllowed(cfg);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(OrbitError);
      const err = caught as OrbitError;
      expect(err.code).toBe('compliance_refused');
      expect(err.exitCode).toBe(ExitCode.complianceRefused);
      expect(err.message).toBe(checkCliDriverAllowed(cfg).message);
      expect(err.hint).toBe(GUARD_API_KEY_HOWTO);
      expect(err.hint).toMatch(/use an API key instead/);
      expect(err.hint).toMatch(/ANTHROPIC_API_KEY/);
      expect(err.hint).toMatch(/Bedrock/);
      expect(err.hint).toMatch(/Vertex/);
      expect(err.hint).toMatch(/orbit login-help/);
      expect(err.toJSON()).toEqual({
        code: 'compliance_refused',
        message: err.message,
        hint: GUARD_API_KEY_HOWTO,
      });
    },
  );
});
