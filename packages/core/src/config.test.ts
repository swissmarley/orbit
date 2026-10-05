import { describe, expect, it } from 'vitest';
import {
  OrbitConfig,
  humanPrincipalCount,
  isAllowedIssuer,
  isLoopbackHost,
  principalsByRole,
  roleAtLeast,
} from './config';

describe('OrbitConfig', () => {
  it('applies safe local defaults', () => {
    const c = OrbitConfig.parse({ home: '/tmp/orbit' });
    expect(c.mode).toBe('local');
    expect(c.api).toEqual({ host: '127.0.0.1', port: 7420, allowedOrigins: [] });
    expect(c.driver).toBeNull();
    expect(c.models).toEqual({ default: 'opus', triage: 'haiku' });
    expect(c.sdk.bare).toBe(true);
    expect(c.limits.maxConcurrentRuns.cli).toBe(2);
    expect(humanPrincipalCount(c)).toBe(1);
  });

  it('rejects an empty principal list', () => {
    expect(() => OrbitConfig.parse({ home: '/x', principals: [] })).toThrow();
  });

  it('has no hosted settings by default, and the default principal is the owner', () => {
    const c = OrbitConfig.parse({ home: '/x' });
    expect(c.hosted).toEqual({ publicUrl: null, tls: null, oidc: null });
    expect(c.principals).toEqual([
      { id: 'owner', kind: 'human', name: 'Local owner', role: 'owner' },
    ]);
    expect(principalsByRole(c)).toEqual({ owner: 1, operator: 0, viewer: 0 });
  });
});

describe('principals and roles (ADR-015)', () => {
  it('roles default to owner and rank viewer < operator < owner', () => {
    const c = OrbitConfig.parse({
      home: '/x',
      principals: [
        { id: 'ada', kind: 'human' },
        { id: 'bob', kind: 'human', role: 'operator', oidc: { subject: 'sub-bob' } },
        { id: 'cy', kind: 'human', role: 'viewer', oidc: { email: 'Cy@Example.COM' } },
      ],
    });
    expect(c.principals.map((p) => p.role)).toEqual(['owner', 'operator', 'viewer']);
    expect(c.principals[2]?.oidc).toEqual({ email: 'cy@example.com' });
    expect(principalsByRole(c)).toEqual({ owner: 1, operator: 1, viewer: 1 });
    expect(roleAtLeast('owner', 'operator')).toBe(true);
    expect(roleAtLeast('operator', 'operator')).toBe(true);
    expect(roleAtLeast('operator', 'owner')).toBe(false);
    expect(roleAtLeast('viewer', 'operator')).toBe(false);
  });

  it('refuses duplicate ids, an empty OIDC matcher and one identity for two principals', () => {
    const parse = (principals: unknown) => OrbitConfig.safeParse({ home: '/x', principals });
    expect(
      parse([
        { id: 'a', kind: 'human' },
        { id: 'a', kind: 'human' },
      ]).success,
    ).toBe(false);
    expect(parse([{ id: 'a', kind: 'human', oidc: {} }]).success).toBe(false);
    expect(parse([{ id: 'a', kind: 'human', role: 'admin' }]).success).toBe(false);
    expect(
      parse([
        { id: 'a', kind: 'human', oidc: { subject: 's' } },
        { id: 'b', kind: 'human', oidc: { subject: 's' } },
      ]).success,
    ).toBe(false);
    expect(
      parse([
        { id: 'a', kind: 'human', oidc: { email: 'x@example.com' } },
        { id: 'b', kind: 'human', oidc: { email: 'X@example.com' } },
      ]).success,
    ).toBe(false);
  });
});

describe('hosted settings (ADR-015)', () => {
  const hosted = (h: unknown) => OrbitConfig.safeParse({ home: '/x', hosted: h });

  it('publicUrl must be an https origin and is normalized', () => {
    const ok = hosted({ publicUrl: 'https://Orbit.Example.com/' });
    expect(ok.success && ok.data.hosted.publicUrl).toBe('https://orbit.example.com');
    expect(hosted({ publicUrl: 'https://orbit.example.com:8443' }).success).toBe(true);
    for (const bad of [
      'http://orbit.example.com',
      'https://orbit.example.com/app',
      'https://orbit.example.com?x=1',
      'https://orbit.example.com#x',
      'https://user:pw@orbit.example.com',
      'orbit.example.com',
      'ftp://orbit.example.com',
    ]) {
      expect(hosted({ publicUrl: bad }).success, bad).toBe(false);
    }
  });

  it('the issuer is https, or http on loopback only; scopes include openid', () => {
    const oidc = (o: Record<string, unknown>) => hosted({ oidc: { clientId: 'orbit', ...o } });
    const ok = oidc({ issuer: 'https://id.example.com/realms/orbit' });
    expect(ok.success && ok.data.hosted.oidc).toEqual({
      issuer: 'https://id.example.com/realms/orbit',
      clientId: 'orbit',
      scopes: ['openid', 'email', 'profile'],
    });
    expect(oidc({ issuer: 'http://127.0.0.1:9000' }).success).toBe(true);
    expect(oidc({ issuer: 'http://localhost:9000/x' }).success).toBe(true);
    expect(oidc({ issuer: 'http://id.example.com' }).success).toBe(false);
    expect(oidc({ issuer: 'https://id.example.com?x=1' }).success).toBe(false);
    expect(oidc({ issuer: 'https://id.example.com', scopes: ['email'] }).success).toBe(false);
    expect(oidc({ issuer: 'https://id.example.com', scopes: ['openid', 'a b'] }).success).toBe(
      false,
    );
    expect(isAllowedIssuer('https://u:p@id.example.com')).toBe(false);
  });
});

describe('isLoopbackHost', () => {
  it.each(['127.0.0.1', '127.1.2.3', 'localhost', '::1', '[::1]', '::ffff:127.0.0.1'])(
    '%s is loopback',
    (h) => expect(isLoopbackHost(h)).toBe(true),
  );
  it.each(['0.0.0.0', '::', '192.168.1.10', '10.0.0.1', 'orbit.example.com', '128.0.0.1'])(
    '%s is not loopback',
    (h) => expect(isLoopbackHost(h)).toBe(false),
  );
});
